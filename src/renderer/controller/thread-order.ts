import type { ThreadSortMode } from '@shared/types/state.ts'
import type { SidebarThread } from './sidebar-thread.ts'

/**
 * The order the sidebar shows a project's threads in.
 *
 * The store keeps every project's threads newest-prompted first and several
 * writers rely on that, so the user's choice is applied here, at render time, to
 * a copy. `activity` is the store's own order; `created` and `title` re-sort it.
 * A sort that cannot tell two threads apart (a missing `createdAt`, equal titles)
 * keeps their store order, and `reverse` flips the final order.
 */
export function orderSidebarThreads(
  threads: readonly SidebarThread[],
  mode: ThreadSortMode,
  reverse: boolean,
): SidebarThread[] {
  const ordered = [...threads]
  if (mode === 'created') {
    ordered.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  } else if (mode === 'title') {
    ordered.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
  }
  return reverse ? ordered.reverse() : ordered
}
