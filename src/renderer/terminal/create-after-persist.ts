import type { ApiClient } from '../../preload/api.d.ts'
import { awaitPendingThreadPersistence } from '../controller/persistence.ts'

export type TerminalCreateMeta = {
  label?: string
  projectId: string
  threadId: string | null
}

/**
 * Spawn a PTY only after any in-flight `threads:create` has landed.
 *
 * Opening a new thread with Terminal already visible fires `threads_changed`
 * and `terminal:create` in the same turn. Autosave starts create immediately
 * but does not await it; without this gate main's ownership check can see a
 * missing `meta.json` and report the thread as not belonging to the project.
 */
export async function createTerminalAfterPersist(
  create: ApiClient['terminal']['create'],
  cols: number,
  rows: number,
  meta: TerminalCreateMeta,
  awaitPersistence: () => Promise<void> = awaitPendingThreadPersistence,
): Promise<string> {
  if (meta.threadId) await awaitPersistence()
  return create(cols, rows, meta)
}
