import {
  currentWriterLeaseOwner,
  readWriterLease,
  writerLeaseWasAbandoned,
  type WriterLeaseRecord,
} from '@copse/thread-store/writer-lease.ts'
import type { TranscriptSnapshot } from '@shared/types/stream.ts'
import { listProfileProjectIds } from '../interrupted-turn-resume.ts'
import {
  getProjectThread,
  loadProjectThreadMetas,
  threadDirectoryPath,
  updateMeta,
} from '../thread-store.ts'
import {
  connectTurnWorker,
  turnWorkerSocketPath,
  type TurnWorkerConnection,
  type WorkerToApp,
} from './turn-worker-socket.ts'

/**
 * Turns another Copse process is running in this profile, seen from the app
 * (`docs/plans/local-turn-worker.md` W3, W4): a turn worker handed a turn when
 * the app last quit, still going when the app comes back.
 *
 * The app must neither stamp such a thread interrupted nor continue it itself.
 * It reports the thread as running and attaches to the worker's socket, which
 * streams the turn into the window as an in-process turn would and takes Stop.
 * When no worker answers there it repaints the thread from disk instead. Once
 * the other process lets go of the thread's writer lease, a last repaint from
 * disk settles it.
 */

export interface ForeignTurn {
  projectId: string
  threadId: string
}

export interface ForeignTurnDependencies {
  listProjectIds: () => readonly string[]
  /** Ids of the project's threads whose persisted status is `running`. */
  listRunningThreadIds: (projectId: string) => Promise<readonly string[]>
  /** The thread's live lease, if any. */
  readLease: (projectId: string, threadId: string) => Promise<WriterLeaseRecord | null>
  /** This process's lease owner id. */
  selfOwner: string
  /** Send the window the thread as it is on disk. */
  repaint: (turn: ForeignTurn) => Promise<void>
  /** Open the worker's line for a turn; `null` when nothing answers. */
  connect?: (
    turn: ForeignTurn,
    onMessage: (message: WorkerToApp) => void,
    onClose: () => void,
  ) => Promise<TurnWorkerConnection | null>
  /** Hand the window what the worker streamed. */
  deliver?: (message: WorkerToApp) => void
  /** Whether the thread's lease was left unreleased by a holder that died. */
  leaseAbandoned: (projectId: string, threadId: string) => Promise<boolean>
  /**
   * Settle a thread whose holder died mid-turn: still `running` on disk, it is
   * marked interrupted so the window offers Continue instead of spinning.
   */
  settleAbandoned: (turn: ForeignTurn) => Promise<void>
  /** How often to check a followed thread. */
  intervalMs?: number
  onError?: (error: unknown) => void
}

interface Followed extends ForeignTurn {
  connection: TurnWorkerConnection | null
  /** Stop was pressed before the worker answered; sent as soon as it does. */
  stopPending: boolean
}

export class ForeignTurnFollower {
  private readonly deps: ForeignTurnDependencies
  private readonly following = new Map<string, Followed>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking: Promise<void> = Promise.resolve()

  constructor(deps: ForeignTurnDependencies) {
    this.deps = deps
  }

  /** Thread ids this process is following. */
  threadIds(): string[] {
    return [...this.following.values()].map((turn) => turn.threadId)
  }

  isFollowing(threadId: string): boolean {
    return this.following.has(threadId)
  }

  /** Whether the followed turn is streaming from its worker. */
  isAttached(threadId: string): boolean {
    return (this.following.get(threadId)?.connection ?? null) !== null
  }

  /**
   * Find running threads another live process holds and start following them.
   * Safe to call repeatedly; returns the ids now followed.
   */
  async discover(): Promise<string[]> {
    let added = false
    for (const projectId of this.deps.listProjectIds()) {
      let ids: readonly string[]
      try {
        ids = await this.deps.listRunningThreadIds(projectId)
      } catch (error) {
        this.deps.onError?.(error)
        continue
      }
      for (const threadId of ids) {
        if (this.following.has(threadId)) continue
        const lease = await this.deps.readLease(projectId, threadId).catch((error: unknown) => {
          this.deps.onError?.(error)
          return null
        })
        if (lease === null || lease.owner === this.deps.selfOwner) continue
        this.following.set(threadId, { projectId, threadId, connection: null, stopPending: false })
        added = true
      }
    }
    if (this.following.size > 0) this.start()
    // Attach to new turns now rather than a tick from now.
    if (added) await this.enqueueTick()
    return this.threadIds()
  }

  /**
   * Ask the worker running `threadId` to stop. A worker that does not answer
   * yet (it is still starting) gets the stop as soon as it does. False when the
   * thread is not followed.
   */
  requestStop(threadId: string): boolean {
    const turn = this.following.get(threadId)
    if (!turn) return false
    if (turn.connection) turn.connection.send({ t: 'stop' })
    else turn.stopPending = true
    return true
  }

  /** The window reloaded these threads: send it each attached turn's snapshot again. */
  reattach(projectId: string, threadIds: readonly string[]): void {
    const listed = new Set(threadIds)
    for (const turn of this.following.values()) {
      if (turn.projectId !== projectId) continue
      if (!listed.has(turn.threadId) && listed.size > 0) continue
      turn.connection?.send({ t: 'attach' })
    }
  }

  private start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      void this.enqueueTick()
    }, this.deps.intervalMs ?? 2_000)
    this.timer.unref()
  }

  private enqueueTick(): Promise<void> {
    this.ticking = this.ticking.then(() => this.tick())
    return this.ticking
  }

  /** One pass over every followed thread; finished ones are settled and dropped. */
  async tick(): Promise<void> {
    for (const turn of [...this.following.values()]) {
      try {
        const lease = await this.deps.readLease(turn.projectId, turn.threadId)
        if (lease === null || lease.owner === this.deps.selfOwner) {
          turn.connection?.close()
          turn.connection = null
          const followed = { projectId: turn.projectId, threadId: turn.threadId }
          // A holder that released its lease wrote its own ending. One that died
          // left the thread `running`, and nothing else will settle it.
          if (lease === null && (await this.deps.leaseAbandoned(turn.projectId, turn.threadId)))
            await this.deps.settleAbandoned(followed)
          // Read the lease first: a repaint after the release is the settled thread.
          await this.deps.repaint(followed)
          this.following.delete(turn.threadId)
          continue
        }
        if (turn.connection === null) await this.attach(turn)
        if (turn.connection === null)
          await this.deps.repaint({ projectId: turn.projectId, threadId: turn.threadId })
      } catch (error) {
        this.deps.onError?.(error)
      }
    }
    if (this.following.size === 0) this.stop()
  }

  private async attach(turn: Followed): Promise<void> {
    if (!this.deps.connect) return
    const connection = await this.deps.connect(
      turn,
      (message) => {
        // Only the followed thread's own stream reaches the window.
        const forTurn =
          message.t === 'chunk'
            ? message.threadId === turn.threadId
            : message.snapshot.projectId === turn.projectId &&
              message.snapshot.thread.id === turn.threadId
        if (forTurn) this.deps.deliver?.(message)
      },
      () => {
        if (turn.connection === connection) turn.connection = null
      },
    )
    if (connection === null) return
    turn.connection = connection
    connection.send({ t: 'attach' })
    if (turn.stopPending) {
      turn.stopPending = false
      connection.send({ t: 'stop' })
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    for (const turn of this.following.values()) {
      turn.connection?.close()
      turn.connection = null
    }
  }
}

/** The profile's stores and workers, delivering into the window's own channels. */
export function defaultForeignTurnDependencies(
  userDataPath: string,
  window: {
    snapshot: (snapshot: TranscriptSnapshot) => void
    chunk: (message: Extract<WorkerToApp, { t: 'chunk' }>) => void
  },
): ForeignTurnDependencies {
  return {
    listProjectIds: listProfileProjectIds,
    listRunningThreadIds: async (projectId) =>
      (await loadProjectThreadMetas(projectId))
        .filter((meta) => meta.status === 'running')
        .map((meta) => meta.id),
    readLease: (projectId, threadId) =>
      readWriterLease(threadDirectoryPath(projectId, threadId), threadId),
    selfOwner: currentWriterLeaseOwner().id,
    leaseAbandoned: (projectId, threadId) =>
      writerLeaseWasAbandoned(threadDirectoryPath(projectId, threadId), threadId),
    settleAbandoned: async ({ projectId, threadId }): Promise<void> => {
      const meta = (await loadProjectThreadMetas(projectId)).find((m) => m.id === threadId)
      if (meta?.status !== 'running') return
      await updateMeta(projectId, threadId, { status: 'idle', interruptedTurnAt: Date.now() })
    },
    repaint: async ({ projectId, threadId }): Promise<void> => {
      const thread = await getProjectThread(projectId, threadId)
      if (thread)
        window.snapshot({
          projectId,
          source: 'disk',
          thread,
          checkpoint: { stream: null, pendingTurn: null },
        })
    },
    connect: (turn, onMessage, onClose) =>
      connectTurnWorker(turnWorkerSocketPath(userDataPath, turn.threadId), onMessage, onClose),
    deliver: (message): void => {
      if (message.t === 'snapshot') window.snapshot(message.snapshot)
      else window.chunk(message)
    },
    onError: (error): void => {
      console.error('[turn-worker] could not follow a handed-off turn:', error)
    },
  }
}
