/**
 * Tools that only function with subagents on, hidden from the parent when they
 * are off: the subagent entry points, and `read_explored`, which quotes what
 * explore subagents read (#1433, Fix 0b) and has nothing to serve without them.
 */
export const SUBAGENT_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'explore',
  'investigate_ci',
  'read_explored',
])
