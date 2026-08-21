import { safeJsonParse } from '@shared/safe-json.ts'
import { isRecord } from '@shared/unknown-value.ts'

/**
 * Drag payload + drop geometry for the projects sidebar (issue #1685).
 *
 * Kept apart from `projects-pane.ts` so the two decisions a drop rests on — is
 * this our drag, and which side of the row did it land on — are pure functions
 * with their own tests, rather than logic reachable only through a real
 * DragEvent.
 */

/**
 * Private MIME for sidebar drags, following `WORKSPACE_PATH_MIME`. A custom type
 * is what lets `dragover` tell a project drag from a file dragged in from
 * Finder: the payload itself is unreadable until `drop`, but the *type list* is
 * always visible, so an OS file drag never paints a reorder indicator.
 */
export const SIDEBAR_DRAG_MIME = 'application/x-copse-panel-sidebar-item'

/** What is being dragged: a project row, or a whole group by its header. */
export type SidebarDragKind = 'project' | 'group'

export interface SidebarDragPayload {
  kind: SidebarDragKind
  id: string
}

/** Where a drop lands: on one side of the row, or inside it (group headers). */
export type DropIntent = 'before' | 'after' | 'into'

/** Fraction of a group header's height at each end that reorders instead of nesting. */
const GROUP_EDGE_BAND = 0.25

export function serializeSidebarDrag(payload: SidebarDragPayload): string {
  return JSON.stringify(payload)
}

/** Decode a drag payload, returning null for anything that isn't one of ours. */
export function parseSidebarDrag(raw: string): SidebarDragPayload | null {
  const parsed = safeJsonParse(raw)
  if (!isRecord(parsed)) return null
  const kind = parsed['kind']
  const id = parsed['id']
  if (kind !== 'project' && kind !== 'group') return null
  if (typeof id !== 'string' || id === '') return null
  return { kind, id }
}

/** Only the geometry {@link dropIntent} needs, so tests need no real DOMRect. */
export interface RowBounds {
  top: number
  height: number
}

/**
 * Which drop a pointer at `clientY` means for a row.
 *
 * A plain row splits in half: above the midpoint drops before it, below drops
 * after. A group header splits in three so it can accept both — the outer
 * quarters reorder the group, and the middle half drops *into* it. Without that
 * middle band a group header could only ever be reordered, and there would be no
 * pointer position that means "put this project in this group".
 */
export function dropIntent(
  clientY: number,
  bounds: RowBounds,
  options: { allowInto?: boolean } = {},
): DropIntent {
  const height = bounds.height
  // A row with no measurable height (hidden, or an unlaid-out test fixture) has
  // no meaningful midpoint; treat the whole thing as its leading edge.
  if (height <= 0) return 'before'
  const offset = (clientY - bounds.top) / height
  if (options.allowInto === true) {
    if (offset < GROUP_EDGE_BAND) return 'before'
    if (offset > 1 - GROUP_EDGE_BAND) return 'after'
    return 'into'
  }
  return offset < 0.5 ? 'before' : 'after'
}

/** True when `event` carries a sidebar drag rather than files or foreign data. */
export function isSidebarDrag(types: readonly string[] | DOMStringList | undefined): boolean {
  if (!types) return false
  return Array.from(types).includes(SIDEBAR_DRAG_MIME)
}
