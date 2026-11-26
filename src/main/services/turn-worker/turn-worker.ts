import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  currentWriterLeaseOwner,
  readWriterLease,
  type WriterLeaseRecord,
} from '@copse/thread-store/writer-lease.ts'
import { parseChatGptPlanModel } from '@copse/llm/chatgpt-plan.ts'
import type { StreamChunk } from '@shared/types'
import { AgentDispatcher } from '../agent-dispatcher.ts'
import { runWithApprovalHandler } from '../approval.ts'
import { beginDeferralMode, endDeferralMode } from '../security/deferral-mode.ts'
import { getSetting } from '../storage/settings.ts'
import {
  appendMessage,
  getProjectThread,
  threadDirectoryPath,
  updateMeta,
} from '../thread-store.ts'
import type { ToolRegistry } from '../tool-registry.ts'
import { TurnTranscriptWriter } from '../turn-transcript-writer.ts'
import {
  defaultInterruptedTurnResumeDependencies,
  resumeInterruptedTurns,
  type ResumedTurn,
} from '../interrupted-turn-resume.ts'

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
}

export type TurnWorkerOutcome =
  | { status: 'continued'; result: ResumedTurn['result'] }
  | { status: 'not-resumable' }
  | { status: 'held'; holder: Pick<WriterLeaseRecord, 'host' | 'pid'> }

const HAND_OFF_POLL_MS = 100

/**
 * Wait for the app that started this worker to release the thread. It stops its
 * turn before it exits, but releasing the lease is part of that stop, which may
 * still be finishing when this process is already running.
 */
async function waitForHandOff(
  threadDir: string,
  threadId: string,
  waitMs: number,
): Promise<WriterLeaseRecord | null> {
  const self = currentWriterLeaseOwner().id
  const deadline = Date.now() + waitMs
  for (;;) {
    const holder = await readWriterLease(threadDir, threadId)
    if (holder === null || holder.owner === self) return null
    if (Date.now() >= deadline) return holder
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
  const { projectId, threadId } = request
  const threadDir = deps.threadDir ?? threadDirectoryPath(projectId, threadId)
  const holder = await waitForHandOff(threadDir, threadId, deps.handOffWaitMs ?? 30_000)
  if (holder !== null) {
    deps.log(`thread ${threadId} is still held by ${holder.host} pid ${String(holder.pid)}`)
    return { status: 'held', holder: { host: holder.host, pid: holder.pid } }
  }

  const reason = await workerCannotRun(projectId, threadId)
  if (reason !== null) {
    deps.log(`thread ${threadId} stays for the next launch: ${reason}`)
    return { status: 'not-resumable' }
  }
  deps.log(`thread ${threadId}: continuing the turn`)

  const transcripts = new TurnTranscriptWriter({
    // No window is listening; the thread's files are the record.
    forward: (): void => undefined,
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
          // The app handed this thread over as it quit, so it is the run this
          // worker exists to continue, whatever the profile's last-run record says.
          previousRun: () => Promise.resolve({ startedAt: 0 }),
          onError: (error): void => {
            deps.log(`could not continue the turn: ${String(error)}`)
          },
        }),
    )
    await transcripts.settled(threadId)
    const turn = resumed[0]
    if (!turn) {
      deps.log(`thread ${threadId}: nothing to continue`)
      return { status: 'not-resumable' }
    }
    deps.log(`thread ${threadId}: turn ended (${turn.result})`)
    return { status: 'continued', result: turn.result }
  } finally {
    endDeferralMode(threadId)
  }
}
