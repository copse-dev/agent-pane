import { READ_TERMINAL_DEFAULT_LINES } from '@shared/terminal/read-terminal.ts'

/** One open Shells tab, for `@shell` mentions and agent-facing catalogs. */
export interface ShellCatalogEntry {
  tabId: string
  sessionId: string | null
  label: string
  scopeId: string | null
  active: boolean
}

export type ShellCatalogLister = () => ShellCatalogEntry[]
export type ShellScrollbackReader = (tabId: string, maxLines?: number) => string | null

let listShells: ShellCatalogLister | null = null
let readScrollback: ShellScrollbackReader | null = null

/** Wired by `mountTerminalsPane` so the mention picker can see live tabs. */
export function registerShellCatalog(
  list: ShellCatalogLister,
  read: ShellScrollbackReader,
): () => void {
  listShells = list
  readScrollback = read
  return () => {
    if (listShells === list) listShells = null
    if (readScrollback === read) readScrollback = null
  }
}

/** Open shells for a thread (or all tabs when `threadId` is null). */
export function listShellsForThread(threadId: string | null): ShellCatalogEntry[] {
  if (!listShells) return []
  const all = listShells()
  if (threadId === null) return all
  return all.filter((s) => s.scopeId === threadId)
}

/** Snapshot scrollback for a tab; `null` when the tab is unknown. */
export function readShellScrollback(
  tabId: string,
  maxLines: number = READ_TERMINAL_DEFAULT_LINES,
): string | null {
  if (!readScrollback) return null
  return readScrollback(tabId, maxLines)
}
