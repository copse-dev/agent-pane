import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { WriterLeaseRecord } from '@copse/thread-store/writer-lease.ts'
import { isChatGptPlanModel } from '@copse/llm/chatgpt-plan.ts'
import type { StreamChunk } from '@shared/types'
import { isAcpModel } from '@shared/acp.ts'
import { isRemoteAgentModel } from '@shared/remote-agent.ts'
import {
  AgentDispatcher,
  defaultAgentDispatcherDependencies,
  type AgentDispatcherDependencies,
} from '../agent-dispatcher.ts'
import { abortAgent } from '../agent-service.ts'
import { runWithApprovalHandler } from '../approval.ts'
import { runWithStagedDiffResolver } from '../diff-queue.ts'
import { beginDeferralMode, endDeferralMode } from '../security/deferral-mode.ts'
import { getSetting } from '../storage/settings.ts'
import {
  appendMessage,
  placeMessageAfter,
  getProjectThread,
  loadProjectThreadMetas,
  loadThreadMessages,
  updateMeta,
} from '../thread-store.ts'
import { claimThreadWriter, type ThreadWriterClaimResult } from '../thread-writer-lease.ts'
import type { ToolRegistry } from '../tool-registry.ts'
import { TurnTranscriptWriter } from '../turn-transcript-writer.ts'
import {
  defaultInterruptedTurnResumeDependencies,
  resumeInterruptedTurns,
  transcriptCanResume,
  wasInterruptedByExit,
  type ResumedTurn,
} from '../interrupted-turn-resume.ts'
import { serveTurnWorker, type TurnWorkerServer, type WorkerToApp } from './turn-worker-socket.ts'

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
  /** The line already served with {@link openTurnControl}; opened here when absent. */
  control?: TurnControl
}

export interface TakenOverThread {
  readonly lease: WriterLeaseRecord
  /** Run `listener` if another process takes the thread over. */
  onLost: (listener: () => void) => void
  /** Give the thread back. Safe to call more than once. */
  release: () => Promise<void>
}

export type TakeOverResult =
  | { status: 'taken'; thread: TakenOverThread }
  | { status: 'held'; holder: Pick<WriterLeaseRecord, 'host' | 'pid'> }

export type TurnWorkerOutcome =
  | { status: 'continued'; result: ResumedTurn['result'] }
  | { status: 'not-resumable' }
  | { status: 'stopped' }
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
 * instead of continuing it too. The turn runs under this same claim, and the
 * worker gives it back only once the turn's last write has landed.
 */
export async function takeOverThread(
  request: TurnWorkerRequest,
  options: { waitMs?: number; threadDir?: string; log: (line: string) => void },
): Promise<TakeOverResult> {
  const deadline = Date.now() + (options.waitMs ?? 30_000)
  const lostListeners: (() => void)[] = []
  for (;;) {
    const result = await claimThreadWriter(request.projectId, request.threadId, {
      onLost: () => {
        options.log(`gave up the lease on thread ${request.threadId}`)
        for (const listener of lostListeners) listener()
      },
      ...(options.threadDir !== undefined ? { threadDir: options.threadDir } : {}),
    })
    if (result.status === 'claimed') {
      const claim = result.claim
      return {
        status: 'taken',
        thread: {
          lease: claim.lease,
          onLost: (listener): void => {
            lostListeners.push(listener)
          },
          release: () => claim.release(),
        },
      }
    }
    if (Date.now() >= deadline) {
      const { host, pid } = result.holder
      options.log(`thread ${request.threadId} is still held by ${host} pid ${String(pid)}`)
      return { status: 'held', holder: { host, pid } }
    }
    await delay(HAND_OFF_POLL_MS)
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
export async function workerCannotRun(projectId: string, threadId: string): Promise<string | null> {
  const thread = await getProjectThread(projectId, threadId)
  const setting = getSetting<unknown>('model', undefined)
  const model = thread?.model ?? (typeof setting === 'string' ? setting : undefined)
  return modelCannotRunInWorker(model)
}

/** Why a turn on `model` must run in the app, or null when a worker can run it. */
export function modelCannotRunInWorker(model: string | undefined): string | null {
  if (model === undefined) return null
  if (isChatGptPlanModel(model))
    return 'its model signs in with ChatGPT, whose tokens only the app can save'
  // The worker runs Copse's own loop and hosts no external agent CLI
  // (local-turn-worker.md): it could not stop one, or the processes it starts,
  // once it exits. The next launch continues these, as the hand-off record says.
  if (isAcpModel(model)) return 'it runs on an external coding agent, which only the app hosts'
  if (isRemoteAgentModel(model)) return 'it runs on a remote agent, which only the app connects to'
  return null
}

/**
 * Why this worker must leave the thread alone, or null when it continues it:
 * the same rules the next launch applies (`interrupted-turn-resume.ts`), then
 * {@link workerCannotRun}. Checked before the thread is taken over, so a thread
 * the worker declines is never held while it boots: a relaunched app would
 * follow it instead of draining its queue or continuing it.
 */
export async function whyNotContinue(projectId: string, threadId: string): Promise<string | null> {
  const meta = (await loadProjectThreadMetas(projectId)).find((m) => m.id === threadId)
  if (!meta) return 'the thread is gone'
  if (!wasInterruptedByExit(meta, Date.now() - process.uptime() * 1_000))
    return 'the next launch or the window continues it, not a worker'
  if (!transcriptCanResume(await loadThreadMessages(projectId, threadId)))
    return 'its transcript does not end in a turn to continue'
  return workerCannotRun(projectId, threadId)
}

/**
 * The worker's line to an attaching app (`turn-worker-socket.ts`), served from
 * the moment the thread is taken over, through the boot, until the worker is
 * done, so Stop is never pressed into silence. A stop that arrives before the
 * turn runs is kept: the turn is then not started at all.
 */
export class TurnControl {
  server: TurnWorkerServer | null = null
  private stopped = false
  private attached = false
  private handlers: { onAttach: () => void; onStop: () => void } | null = null

  get stopRequested(): boolean {
    return this.stopped
  }

  /** The running turn's handlers. An attach that came first is answered now. */
  bind(handlers: { onAttach: () => void; onStop: () => void }): void {
    this.handlers = handlers
    if (this.attached) handlers.onAttach()
  }

  readonly handleAttach = (): void => {
    this.attached = true
    this.handlers?.onAttach()
  }

  readonly handleStop = (): void => {
    this.stopped = true
    this.handlers?.onStop()
  }

  broadcast(message: WorkerToApp): void {
    this.server?.broadcast(message)
  }

  async close(): Promise<void> {
    await this.server?.close()
    this.server = null
  }
}

/** Serve the thread on `socketPath`; a failure leaves the turn unserved, not stopped. */
export async function openTurnControl(
  socketPath: string | undefined,
  log: (line: string) => void,
): Promise<TurnControl> {
  const control = new TurnControl()
  if (socketPath === undefined) return control
  try {
    control.server = await serveTurnWorker(socketPath, {
      onAttach: control.handleAttach,
      onStop: control.handleStop,
    })
  } catch (error) {
    log(`could not serve the turn for attaching: ${String(error)}`)
  }
  return control
}

export async function runTurnWorker(
  request: TurnWorkerRequest,
  deps: TurnWorkerDependencies,
): Promise<TurnWorkerOutcome> {
  let thread = deps.takenOver
  if (!thread) {
    const reason = await whyNotContinue(request.projectId, request.threadId)
    if (reason !== null) {
      deps.log(`thread ${request.threadId} stays for the next launch: ${reason}`)
      return { status: 'not-resumable' }
    }
    const result = await takeOverThread(request, {
      log: deps.log,
      ...(deps.handOffWaitMs !== undefined ? { waitMs: deps.handOffWaitMs } : {}),
      ...(deps.threadDir !== undefined ? { threadDir: deps.threadDir } : {}),
    })
    if (result.status === 'held') return result
    thread = result.thread
  }
  const control = deps.control ?? (await openTurnControl(deps.socketPath, deps.log))
  try {
    return await continueTurn(request, deps, thread, control)
  } finally {
    // The turn's last write has landed (`continueTurn` waits for it): only now
    // may another process take the thread.
    if (!deps.control) await control.close()
    await thread.release()
  }
}

async function continueTurn(
  request: TurnWorkerRequest,
  deps: TurnWorkerDependencies,
  thread: TakenOverThread,
  control: TurnControl,
): Promise<TurnWorkerOutcome> {
  const { projectId, threadId } = request
  const reason = await whyNotContinue(projectId, threadId)
  if (reason !== null) {
    deps.log(`thread ${threadId} stays for the next launch: ${reason}`)
    return { status: 'not-resumable' }
  }
  if (control.stopRequested) return settleStoppedBeforeStart(request, deps)
  deps.log(`thread ${threadId}: continuing the turn`)

  const transcripts = new TurnTranscriptWriter({
    // The thread's files are the record; an attached app also gets the stream.
    forward: (chunkThreadId, chunk, stamp): void => {
      control.broadcast({
        t: 'chunk',
        threadId: chunkThreadId,
        chunk,
        ...(stamp ? { stamp } : {}),
      })
    },
    snapshot: (snapshot): void => {
      control.broadcast({ t: 'snapshot', snapshot })
    },
    loadThread: getProjectThread,
    appendMessage,
    placeMessageAfter,
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
  const dispatcher = new AgentDispatcher(
    host,
    deps.registry,
    {
      ...defaultAgentDispatcherDependencies,
      // The turn runs under the worker's own claim, which outlives it: the
      // lease is given back once the turn's last write has landed, not at the
      // end of the turn, so nothing else starts on the thread under that write.
      claimWriter: (_projectId, _threadId, onLost): Promise<ThreadWriterClaimResult> => {
        thread.onLost(onLost)
        return Promise.resolve({
          status: 'claimed',
          claim: { lease: thread.lease, release: () => Promise.resolve() },
        })
      },
      // `runAgent` registers its abort controller as it starts, so a stop that
      // came between the check above and now still reaches the turn.
      run: (...args): ReturnType<AgentDispatcherDependencies['run']> => {
        const running = defaultAgentDispatcherDependencies.run(...args)
        if (control.stopRequested) abortAgent(threadId)
        return running
      },
    },
    transcripts,
  )
  control.bind({
    onAttach: () => {
      void transcripts.attach(projectId, [threadId])
    },
    onStop: () => {
      deps.log(`stop requested for thread ${threadId}`)
      transcripts.noteUserAbort(threadId, 'stop')
      abortAgent(threadId)
    },
  })

  const resume = defaultInterruptedTurnResumeDependencies(dispatcher)
  beginDeferralMode(threadId)
  try {
    const resumed = await runWithApprovalHandler(
      () => Promise.resolve({ approved: false, remember: false }),
      () =>
        // A staged edit would wait for a diff panel that no window shows, and
        // vanish with this process. Refuse it, so the model is told nothing was
        // written instead of that the user will review it.
        runWithStagedDiffResolver(
          () => Promise.resolve(false),
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
        ),
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

/**
 * Stop was pressed while the worker was still starting: the continuation never
 * runs. The thread is settled the way a relaunch settles a cut-off turn, so the
 * window offers Continue rather than spinning.
 */
async function settleStoppedBeforeStart(
  request: TurnWorkerRequest,
  deps: TurnWorkerDependencies,
): Promise<TurnWorkerOutcome> {
  deps.log(`thread ${request.threadId}: stopped before the turn started`)
  await updateMeta(request.projectId, request.threadId, {
    status: 'idle',
    interruptedTurnAt: Date.now(),
  })
  return { status: 'stopped' }
}
