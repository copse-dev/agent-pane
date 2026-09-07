/**
 * The project and thread a new terminal tab is scoped to.
 *
 * A shell is spawned against the pair, and main refuses a thread that belongs
 * to another project — so a mismatched pair is not a wrong working directory,
 * it is a terminal that cannot start at all (#2484). The store can hold such a
 * pair briefly while a project hand-off is in flight, and durably when that
 * hand-off gives up part-way, so the pane checks rather than assumes.
 *
 * Pure, and taking the snapshot as an argument, because the bug it exists for
 * is a *torn read*: two `getState()` calls either side of a state change. One
 * snapshot in, one decision out.
 */

export interface TerminalTabScopeState {
  activeProjectId: string | null
  activeThreadId: string | null
  /** Threads of the active project — the membership list this checks against. */
  threads: readonly { id: string }[]
}

export interface TerminalTabScope {
  scopeProjectId: string | null
  scopeId: string | null
}

/**
 * `options` wins untouched when either half is given: it names a project the
 * store is not on (a tab being restored, or re-created for a worktree), and
 * `state.threads` says nothing about that project's membership.
 *
 * Otherwise the thread is kept only if the active project actually has it.
 * Dropping it leaves a working shell in the project root — what a tab opened
 * with no thread gets anyway — rather than one that refuses to open.
 */
export function resolveTerminalTabScope(
  state: TerminalTabScopeState,
  options?: { scopeProjectId?: string; scopeId?: string },
): TerminalTabScope {
  if (options?.scopeProjectId !== undefined || options?.scopeId !== undefined) {
    return {
      scopeProjectId: options.scopeProjectId ?? null,
      scopeId: options.scopeId ?? null,
    }
  }
  const { activeProjectId, activeThreadId, threads } = state
  const belongs = activeThreadId !== null && threads.some((thread) => thread.id === activeThreadId)
  return { scopeProjectId: activeProjectId, scopeId: belongs ? activeThreadId : null }
}
