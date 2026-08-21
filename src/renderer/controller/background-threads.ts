/**
 * Live runs carried across project switches (#1841).
 *
 * `state.threads` always belongs to the active project, so a project switch
 * used to drop a running thread from the store entirely: every subsequent
 * agent chunk silently no-opped (`addMessage`/`appendToken` found no thread),
 * and — because the renderer is the only writer of the display transcript —
 * messages finalized while the user was away were never persisted at all.
 *
 * Instead, a switch now moves the outgoing project's running threads into
 * `state.backgroundThreads`, where the ordinary store helpers keep applying
 * chunks (see `patchThreadAnywhere` / `messageLocations` in thread-helpers).
 * Activating the owning project adopts them back, preferring the in-memory
 * copy — it holds everything streamed while the user was away, which the disk
 * read may not.
 */
import type { AppStore } from '@shared/store/store.ts'
import type { BackgroundThread, Thread } from '@shared/types'

/**
 * Move the outgoing project's live runs into the background list. Called on
 * project switch with the thread list being replaced. Idempotent per thread:
 * a re-entrant switch cannot duplicate an entry.
 */
export function carryRunningThreads(
  store: AppStore,
  outgoingProjectId: string,
  outgoingThreads: readonly Thread[],
): void {
  const running = outgoingThreads.filter((t) => t.status === 'running')
  if (running.length === 0) return
  const existing = store.getState().backgroundThreads
  const carriedIds = new Set(existing.map((b) => b.thread.id))
  const added: BackgroundThread[] = running
    .filter((t) => !carriedIds.has(t.id))
    .map((thread) => ({ projectId: outgoingProjectId, thread }))
  if (added.length === 0) return
  store.setState({ backgroundThreads: [...existing, ...added] })
}

/**
 * Fold `projectId`'s background threads into its freshly loaded disk list and
 * release them from the background set. Returns the merged list for the caller
 * to apply as `state.threads`.
 *
 * The in-memory copy wins wholesale: it kept receiving every chunk while the
 * user was away, so it is at least as fresh as the metadata-only disk read.
 * A carried copy that was never hydrated stays `messagesLoaded: false` and
 * goes through ordinary hydration on selection — whose disk-∪-memory merge
 * (see `fetchInto` in thread-hydration.ts) keeps the streamed-while-away
 * messages the disk transcript may not have yet.
 */
export function adoptBackgroundThreads(
  store: AppStore,
  projectId: string,
  disk: readonly Thread[],
): Thread[] {
  const { backgroundThreads } = store.getState()
  const adopting = new Map(
    backgroundThreads.filter((b) => b.projectId === projectId).map((b) => [b.thread.id, b.thread]),
  )
  if (adopting.size === 0) return [...disk]
  store.setState({
    backgroundThreads: backgroundThreads.filter((b) => b.projectId !== projectId),
  })
  const merged = disk.map((diskThread) => {
    const memory = adopting.get(diskThread.id)
    if (!memory) return diskThread
    adopting.delete(diskThread.id)
    return memory
  })
  // A carried thread missing from the disk read (e.g. created and never yet
  // reconciled) still belongs in the list — dropping it would detach its run.
  return [...merged, ...adopting.values()]
}

/** The owning project of a carried thread, or undefined when it is not carried. */
export function backgroundProjectOf(store: AppStore, threadId: string): string | undefined {
  return store.getState().backgroundThreads.find((b) => b.thread.id === threadId)?.projectId
}

/** Drop one carried thread after its final background bookkeeping is complete. */
export function dropBackgroundThread(store: AppStore, threadId: string): void {
  const { backgroundThreads } = store.getState()
  if (!backgroundThreads.some((b) => b.thread.id === threadId)) return
  store.setState({
    backgroundThreads: backgroundThreads.filter((b) => b.thread.id !== threadId),
  })
}

/**
 * Release a removed project's completed carried threads. A live run must stay
 * reachable until `done` persists its final message and metadata; the agent
 * controller drops that last entry afterwards.
 */
export function dropProjectBackgroundThreads(store: AppStore, projectId: string): void {
  const { backgroundThreads } = store.getState()
  if (!backgroundThreads.some((b) => b.projectId === projectId)) return
  store.setState({
    backgroundThreads: backgroundThreads.filter(
      (b) => b.projectId !== projectId || b.thread.status === 'running',
    ),
  })
}
