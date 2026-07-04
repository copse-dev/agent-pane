// Pure helpers for scoping terminal shells and agent-task panels to a single
// "scope" — the active thread (issue #502 was originally per-project; shells and
// agent runs are now bound to the thread they were created under, and each
// thread belongs to exactly one project, so thread scoping is strictly finer).
// The views keep a flat collection of tabs each tagged with the scope they
// belong to; on a scope switch only the active scope's tabs are shown and the
// others are hidden (not destroyed), so switching back restores that thread's
// shells and agent runs.

export interface Scoped {
  /** Thread this tab belongs to; only the active thread's tabs are shown. */
  scopeId: string | null
}

/** Tabs belonging to the given scope (in their original order). */
export function tabsForScope<T extends Scoped>(tabs: Iterable<T>, scopeId: string | null): T[] {
  return [...tabs].filter((t) => t.scopeId === scopeId)
}

/** True when the tab should be visible for the active scope. */
export function isTabVisibleForScope(tab: Scoped, activeScopeId: string | null): boolean {
  return tab.scopeId === activeScopeId
}

export interface ScopePlan<T> {
  /** Tabs to show (belong to the now-active scope). */
  visible: T[]
  /** Tabs to hide (belong to other scopes). */
  hidden: T[]
  /** True when the active scope has no tabs yet (caller may create a fresh one). */
  needsNew: boolean
}

/**
 * Partition tabs by whether they belong to the now-active scope. Used on a
 * thread switch to decide which terminal/agent panels to show vs. hide, and
 * whether a fresh tab is needed for a thread being viewed for the first time.
 */
export function planScope<T extends Scoped>(
  tabs: Iterable<T>,
  activeScopeId: string | null,
): ScopePlan<T> {
  const visible: T[] = []
  const hidden: T[] = []
  for (const tab of tabs) {
    if (isTabVisibleForScope(tab, activeScopeId)) visible.push(tab)
    else hidden.push(tab)
  }
  return { visible, hidden, needsNew: activeScopeId !== null && visible.length === 0 }
}
