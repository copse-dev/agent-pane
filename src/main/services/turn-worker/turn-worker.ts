import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { WriterLeaseRecord } from '@copse/thread-store/writer-lease.ts'
import { parseChatGptPlanModel } from '@copse/llm/chatgpt-plan.ts'
import type { StreamChunk } from '@shared/types'
import { AgentDispatcher } from '../agent-dispatcher.ts'
import { abortAgent } from '../agent-service.ts'
import { runWithApprovalHandler } from '../approval.ts'
import { beginDeferralMode, endDeferralMode } from '../security/deferral-mode.ts'
import { getSetting } from '../storage/settings.ts'
import { appendMessage, getProjectThread, updateMeta } from '../thread-store.ts'
import { claimThreadWriter } from '../thread-writer-lease.ts'
import type { ToolRegistry } from '../tool-registry.ts'
import { TurnTranscriptWriter } from '../turn-transcript-writer.ts'
import {
  defaultInterruptedTurnResumeDependencies,
  resumeInterruptedTurns,
  type ResumedTurn,
} from '../interrupted-turn-resume.ts'
import { serveTurnWorker, type TurnWorkerServer } from './turn-worker-socket.ts'

/**
 * One handed-off turn, run outside the app (`docs/plans/local-turn-worker.md`).
 *
 * The desktop stopped the turn when it quit and started this process for the
 * thread. It continues the turn exactly as the next launch would have
 * (`interrupted-turn-resume.ts`), through the same dispatcher and the same
 * main-owned transcript writer, so the thread's files read as if the app had
 * never left. The dispatcher takes the thread's writer lease before writing.
 *
 * Nobody is watching, so anything the permission policy would ask about is
 * deferred for the user's review (`deferral-mode.ts`), and a prompt that still
 * reaches a handler is refused.
 *
 * While the turn runs, the worker serves it on `socketPath`
 * (`turn-worker-socket.ts`): a relaunched app attaches there to stream the
 * turn live and to stop it.
 */

export interface TurnWorkerRequest {
  projectId: string
  threadId: string
}

export interface TurnWorkerDependencies {
  registry: ToolRegistry
  log: (line: string) => void
  /** How long to wait for the quitting app to let go of the thread. */
  handOffWaitMs?: number
  /** Where the thread lives; the profile's store by default. */
  threadDir?: string
  /** Where to serve the turn to an attaching app; not served when absent. */
  socketPath?: string
  /** The thread, already taken over with {@link takeOverThread}; taken here when absent. */
  takenOver?: TakenOverThread
}

export interface TakenOverThread {
  /** Give the thread back. Safe to call more than once. */
  release: () => Promise<void>
}

export type TakeOverResult =
  | { status: 'taken'; thread: TakenOverThread }
  | { status: 'held'; holder: Pick<WriterLeaseRecord, 'host' | 'pid'> }

export type TurnWorkerOutcome =
  | { status: 'continued'; result: ResumedTurn['result'] }
  | { status: 'not-resumable' }
  | { status: 'held'; holder: Pick<WriterLeaseRecord, 'host' | 'pid'> }

const HAND_OFF_POLL_MS = 100

/**
 * Take the thread's writer lease from the app that started this worker. The app
 * stops its turn before it exits, but releasing the lease is part of that stop,
 * which may still be finishing when this process is already running, so wait
 * up to `waitMs` for it.
 *
 * The worker holds the lease from here until it exits, including its own slow
 * boot, so an app relaunched meanwhile sees the thread taken and follows it
 * instead of continuing it too. The dispatcher's own claim for the turn renews
 * this one (same owner), and its release at the end of the turn ends both.
 */
export async function takeOverThread(
  request: TurnWorkerRequest,
  options: { waitMs?: number; threadDir?: string; log: (line: string) => void },
): Promise<TakeOverResult> {
  const deadline = Date.now() + (options.waitMs ?? 30_000)
  for (;;) {
    const result = await claimThreadWriter(request.projectId, request.threadId, {
      onLost: () => {
        options.log(`gave up the lease on thread ${request.threadId}`)
      },
      ...(options.threadDir !== undefined ? { threadDir: options.threadDir } : {}),
    })
    if (result.status === 'claimed') return { status: 'taken', thread: result.claim }
    if (Date.now() >= deadline) {
      const { host, pid } = result.holder
      options.log(`thread ${request.threadId} is still held by ${host} pid ${String(pid)}`)
      return { status: 'held', holder: { host, pid } }
    }
    await delay(HAND_OFF_POLL_MS)
  }
}

function isChatGptPlanModel(model: string): boolean {
  try {
    return parseChatGptPlanModel(model) !== null
  } catch {
    // A ChatGPT plan value missing its account is still one.
    return true
  }
}

/**
 * Why this thread's turn must wait for the app instead, or null when the worker
 * can run it.
 *
 * A ChatGPT plan model signs in with OAuth. Refreshing that sign-in can rotate
 * the refresh token, and the worker cannot save the new one (decision 4), so
 * the app's saved token would stop working. The turn continues at the next
 * launch instead, as it did before the worker.
 */
async function workerCannotRun(projectId: string, threadId: string): Promise<string | null> {
  const thread = await getProjectThread(projectId, threadId)
  const setting = getSetting<unknown>('model', undefined)
  const model = thread?.model ?? (typeof setting === 'string' ? setting : undefined)
  if (model !== undefined && isChatGptPlanModel(model))
    return 'its model signs in with ChatGPT, whose tokens only the app can save'
  return null
}

export async function runTurnWorker(
  request: TurnWorkerRequest,
  deps: TurnWorkerDependencies,
): Promise<TurnWorkerOutcome> {
  let thread = deps.takenOver
  if (!thread) {
    const result = await takeOverThread(request, {
      log: deps.log,
      ...(deps.handOffWaitMs !== undefined ? { waitMs: deps.handOffWaitMs } : {}),
      ...(deps.threadDir !== undefined ? { threadDir: deps.threadDir } : {}),
    })
    if (result.status === 'held') return result
    thread = result.thread
  }
  try {
    return await continueTurn(request, deps)
  } finally {
    await thread.release()
  }
}

async function continueTurn(
  request: TurnWorkerRequest,
  deps: TurnWorkerDependencies,
): Promise<TurnWorkerOutcome> {
  const { projectId, threadId } = request
  const reason = await workerCannotRun(projectId, threadId)
  if (reason !== null) {
    deps.log(`thread ${threadId} stays for the next launch: ${reason}`)
    return { status: 'not-resumable' }
  }

  let server: TurnWorkerServer | null = null
  const transcripts = new TurnTranscriptWriter({
    // The thread's files are the record; an attached app also gets the stream.
    forward: (chunkThreadId, chunk, stamp): void => {
      server?.broadcast({
        t: 'chunk',
        threadId: chunkThreadId,
        chunk,
        ...(stamp ? { stamp } : {}),
      })
    },
    snapshot: (snapshot): void => {
      server?.broadcast({ t: 'snapshot', snapshot })
    },
    loadThread: getProjectThread,
    appendMessage,
    updateMeta,
    defaultModel: (): string | undefined => {
      const model = getSetting<unknown>('model', undefined)
      return typeof model === 'string' ? model : undefined
    },
    createId: randomUUID,
    onError: (error): void => {
      deps.log(`could not write the transcript: ${String(error)}`)
    },
  })
  const host = {
    emit: (_threadId: string, _chunk: StreamChunk): void => undefined,
  }
  const dispatcher = new AgentDispatcher(host, deps.registry, undefined, transcripts)

  if (deps.socketPath !== undefined) {
    try {
      server = await serveTurnWorker(deps.socketPath, {
        onAttach: () => {
          void transcripts.attach(projectId, [threadId])
        },
        onStop: () => {
          deps.log(`stop requested for thread ${threadId}`)
          transcripts.noteUserAbort(threadId, 'stop')
          abortAgent(threadId)
        },
      })
    } catch (error) {
      deps.log(`could not serve the turn for attaching: ${String(error)}`)
    }
  }

  const resume = defaultInterruptedTurnResumeDependencies(dispatcher)
  beginDeferralMode(threadId)
  try {
    const resumed = await runWithApprovalHandler(
      () => Promise.resolve({ approved: false, remember: false }),
      () =>
        resumeInterruptedTurns({
          ...resume,
          listProjectIds: () => [projectId],
          loadThreadMetas: async (id) =>
            (await resume.loadThreadMetas(id)).filter((meta) => meta.id === threadId),
          // This process runs nothing else; the app's own slots are not ours to see.
          isRunning: () => false,
          onError: (error): void => {
            deps.log(`could not continue the turn: ${String(error)}`)
          },
        }),
    )
    await transcripts.settled(threadId)
    const turn = resumed[0]
    if (!turn) return { status: 'not-resumable' }
    return { status: 'continued', result: turn.result }
  } finally {
    endDeferralMode(threadId)
    await server?.close()
  }
}
