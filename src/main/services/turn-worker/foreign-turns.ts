import {
  currentWriterLeaseOwner,
  readWriterLease,
  type WriterLeaseRecord,
} from '@copse/thread-store/writer-lease.ts'
import type { TranscriptSnapshot } from '@shared/types/stream.ts'
import { listProfileProjectIds } from '../interrupted-turn-resume.ts'
import { getProjectThread, loadProjectThreadMetas, threadDirectoryPath } from '../thread-store.ts'

/**
 * Turns another Copse process is running in this profile, seen from the app
 * (`docs/plans/local-turn-worker.md` W3): a turn worker handed a turn when the
 * app last quit, still going when the app comes back.
 *
 * The app must neither stamp such a thread interrupted nor continue it itself.
 * It reports the thread as running, repaints it from disk while the other
 * process writes, and repaints it a last time once that process lets go of the
 * thread's writer lease, which settles it.
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
  /** How often to repaint a followed thread. */
  intervalMs?: number
  onError?: (error: unknown) => void
}

export class ForeignTurnFollower {
  private readonly deps: ForeignTurnDependencies
  private readonly following = new Map<string, ForeignTurn>()
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

  /**
   * Find running threads another live process holds and start following them.
   * Safe to call repeatedly; returns the ids now followed.
   */
  async discover(): Promise<string[]> {
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
        this.following.set(threadId, { projectId, threadId })
      }
    }
    if (this.following.size > 0) this.start()
    return this.threadIds()
  }

  private start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      this.ticking = this.ticking.then(() => this.tick())
    }, this.deps.intervalMs ?? 2_000)
    this.timer.unref()
  }

  /** One pass: repaint every followed thread, and let go of finished ones. */
  async tick(): Promise<void> {
    for (const turn of [...this.following.values()]) {
      try {
        const lease = await this.deps.readLease(turn.projectId, turn.threadId)
        const finished = lease === null || lease.owner === this.deps.selfOwner
        // Read the lease first: a repaint after the release is the settled thread.
        await this.deps.repaint(turn)
        if (finished) this.following.delete(turn.threadId)
      } catch (error) {
        this.deps.onError?.(error)
      }
    }
    if (this.following.size === 0) this.stop()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }
}

/** The profile's stores, repainting into `send` (the window's snapshot channel). */
export function defaultForeignTurnDependencies(
  send: (snapshot: TranscriptSnapshot) => void,
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
    repaint: async ({ projectId, threadId }): Promise<void> => {
      const thread = await getProjectThread(projectId, threadId)
      if (thread)
        send({ projectId, source: 'disk', thread, checkpoint: { stream: null, pendingTurn: null } })
    },
    onError: (error): void => {
      console.error('[turn-worker] could not follow a handed-off turn:', error)
    },
  }
}
