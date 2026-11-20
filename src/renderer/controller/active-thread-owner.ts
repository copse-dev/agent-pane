import type { AppStore } from '@shared/store/store.ts'
import type { AppState, Thread } from '@shared/types'

export interface ActiveThreadOwner {
  projectId: string
  threadId: string
}

/** Identity sent across IPC so main can derive the task's trusted execution root. */
export function getActiveThreadOwner(store: AppStore): ActiveThreadOwner | null {
  const { activeProjectId, activeThreadId } = store.getState()
  return activeProjectId && activeThreadId
    ? { projectId: activeProjectId, threadId: activeThreadId }
    : null
}

export function requireActiveThreadOwner(store: AppStore): ActiveThreadOwner {
  const owner = getActiveThreadOwner(store)
  if (!owner) throw new Error('No active task')
  return owner
}

/**
 * The active thread as `getThreadById` resolves it, read from `state` so it can
 * be a `store.select` selector. Thread writes replace only the thread they
 * patch, so selecting this (default `Object.is`) follows the active thread's
 * own updates, its messages and status included, and a switch, but not
 * another thread's rename, turn or hydration. Pass {@link sameThreadBesidesDraft}
 * as the equality unless the view shows the draft.
 */
export function activeThreadOf(state: AppState): Thread | undefined {
  const { activeThreadId, threads, backgroundThreads } = state
  if (!activeThreadId) return undefined
  return (
    threads.find((t) => t.id === activeThreadId) ??
    backgroundThreads.find((b) => b.thread.id === activeThreadId)?.thread
  )
}

/** Written on every paused keystroke (draft autosave); not thread state a view shows. */
function besidesDraft(thread: Thread): [string, unknown][] {
  return Object.entries(thread).filter(([key]) => key !== 'draftPrompt' && key !== 'updatedAt')
}

/**
 * `select` equality for {@link activeThreadOf}: the same thread with nothing
 * changed but its draft. Draft autosave replaces the thread object, and
 * `thread_draft_changed` exists so typing does not re-run thread listeners;
 * this keeps a selection of the active thread just as quiet.
 */
export function sameThreadBesidesDraft(a: Thread | undefined, b: Thread | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.id !== b.id) return false
  const left = besidesDraft(a)
  const right = new Map(besidesDraft(b))
  return (
    left.length === right.size &&
    left.every(([key, value]) => right.has(key) && Object.is(value, right.get(key)))
  )
}

/** The active project and thread together: a project switch can reuse a thread id. */
export function activeProjectThreadOf(
  state: AppState,
): readonly [string | null, Thread | undefined] {
  return [state.activeProjectId, activeThreadOf(state)]
}

/** `select` equality for {@link activeProjectThreadOf}, ignoring draft autosaves. */
export function sameProjectThreadBesidesDraft(
  a: readonly [string | null, Thread | undefined],
  b: readonly [string | null, Thread | undefined],
): boolean {
  return a[0] === b[0] && sameThreadBesidesDraft(a[1], b[1])
}
