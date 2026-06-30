// Pure helpers for scoping terminal shells and agent-task panels to the active
// project (issue #502 parts b & c). The views keep a flat collection of tabs each
// tagged with the project they belong to; on a project switch only the active
// project's tabs are shown and the others are hidden (not destroyed), so switching
// back restores that project's shells and agent runs.

export interface ProjectScoped {
  projectId: string | null
}

/** Tabs belonging to the given project (in their original order). */
export function tabsForProject<T extends ProjectScoped>(
  tabs: Iterable<T>,
  projectId: string | null,
): T[] {
  return [...tabs].filter((t) => t.projectId === projectId)
}

/** True when the tab should be visible for the active project. */
export function isTabVisibleForProject(
  tab: ProjectScoped,
  activeProjectId: string | null,
): boolean {
  return tab.projectId === activeProjectId
}

export interface ProjectScopePlan<T> {
  /** Tabs to show (belong to the now-active project). */
  visible: T[]
  /** Tabs to hide (belong to other projects). */
  hidden: T[]
  /** True when the active project has no tabs yet (caller may create a fresh one). */
  needsNew: boolean
}

/**
 * Partition tabs by whether they belong to the now-active project. Used on a
 * project switch to decide which terminal/agent panels to show vs. hide, and
 * whether a fresh tab is needed for a project being viewed for the first time.
 */
export function planProjectScope<T extends ProjectScoped>(
  tabs: Iterable<T>,
  activeProjectId: string | null,
): ProjectScopePlan<T> {
  const visible: T[] = []
  const hidden: T[] = []
  for (const tab of tabs) {
    if (isTabVisibleForProject(tab, activeProjectId)) visible.push(tab)
    else hidden.push(tab)
  }
  return { visible, hidden, needsNew: activeProjectId !== null && visible.length === 0 }
}
