import type { ThreadSortMode } from '@shared/types/state.ts'
import { sidebarLastPromptAt, type SidebarThread } from './sidebar-thread.ts'

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
    // An untitled thread shows as "New Thread", so it sorts as that.
    const name = (thread: SidebarThread): string => thread.title || 'New Thread'
    ordered.sort((a, b) => name(a).localeCompare(name(b), undefined, { sensitivity: 'base' }))
  }
  return reverse ? ordered.reverse() : ordered
}

/** A thread with the project it belongs to, for lists that mix projects. */
export interface SidebarRow {
  projectId: string
  thread: SidebarThread
}

/**
 * Order rows drawn from several projects. Unlike one project's list there is no
 * shared store order to lean on, so `activity` sorts on when the user last prompted
 * each thread (creation time for one nobody has prompted). The other modes and
 * `reverse` match {@link orderSidebarThreads}.
 */
export function orderSidebarRows(
  rows: readonly SidebarRow[],
  mode: ThreadSortMode,
  reverse: boolean,
): SidebarRow[] {
  const created = (row: SidebarRow): number => row.thread.createdAt ?? 0
  const activity = (row: SidebarRow): number => sidebarLastPromptAt(row.thread) ?? created(row)
  const name = (row: SidebarRow): string => row.thread.title || 'New Thread'
  const ordered = [...rows]
  if (mode === 'created') {
    ordered.sort((a, b) => created(b) - created(a))
  } else if (mode === 'title') {
    ordered.sort((a, b) => name(a).localeCompare(name(b), undefined, { sensitivity: 'base' }))
  } else {
    ordered.sort((a, b) => activity(b) - activity(a) || created(b) - created(a))
  }
  return reverse ? ordered.reverse() : ordered
}

export type StatusSectionId = 'needs-you' | 'working' | 'recent'

export interface StatusSection {
  id: StatusSectionId
  label: string
  rows: SidebarRow[]
}

const STATUS_SECTION_LABELS: ReadonlyArray<readonly [StatusSectionId, string]> = [
  ['needs-you', 'Needs you'],
  ['working', 'Working'],
  ['recent', 'Recent'],
]

/**
 * Split rows into Needs you / Working / Recent, keeping their incoming order
 * inside each section and leaving out a section with nothing in it. A thread
 * that is both running and waiting on the user is one that needs them.
 */
export function groupRowsByStatus(
  rows: readonly SidebarRow[],
  needsYou: (threadId: string) => boolean,
): StatusSection[] {
  const sectionOf = (row: SidebarRow): StatusSectionId =>
    needsYou(row.thread.id) ? 'needs-you' : row.thread.status === 'running' ? 'working' : 'recent'
  return STATUS_SECTION_LABELS.map(([id, label]) => ({
    id,
    label,
    rows: rows.filter((row) => sectionOf(row) === id),
  })).filter((section) => section.rows.length > 0)
}
