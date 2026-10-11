import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Writers that can change a checkout without going through the diff queue: the
 * agent's shell commands, supervised background tasks, the user's terminals,
 * worktree preparation installs, MCP tool calls and an external ACP agent's own
 * tools.
 *
 * The diff queue's direct-apply path remembers a sweep that found every
 * `git status` change Copse-owned, instead of re-running `git status` for each
 * file op (#1700). That answer is only complete while Copse is the sole writer,
 * because Copse records every path it writes itself. This registry is how the
 * queue learns it is not: a live writer whose scope overlaps the root forces a
 * live sweep, and starting or finishing a writer advances an epoch that voids
 * any sweep taken before it.
 *
 * Getting a signal wrong in the safe direction only costs a `git status`;
 * missing one leaves the cached sweep to its short TTL. So a scope is the tree
 * the writer runs in, and `null` means it could write anywhere.
 */
let epoch = 0
let nextLeaseId = 0
const liveWriters = new Map<number, string | null>()

/**
 * Register a writer that is live from now until the returned release runs.
 * Release is idempotent, so every exit path of the writer can call it.
 */
export function beginWorktreeWriter(scope: string | null): () => void {
  const id = nextLeaseId++
  liveWriters.set(id, scope === null ? null : resolve(scope))
  epoch++
  let released = false
  return () => {
    if (released) return
    released = true
    liveWriters.delete(id)
    epoch++
  }
}

/** Run `fn` with a writer lease held for its whole duration, released however it settles. */
export async function withWorktreeWriter<T>(
  scope: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const release = beginWorktreeWriter(scope)
  try {
    return await fn()
  } finally {
    release()
  }
}

/**
 * Record a one-shot change Copse did not make file by file: a backup restore, or
 * the user taking the floor between turns.
 */
export function noteWorktreeWrite(): void {
  epoch++
}

/** Advances whenever a writer starts, finishes, or a one-shot write is noted. */
export function worktreeWriteEpoch(): number {
  return epoch
}

/** Whether a live writer could be changing files under `root` right now. */
export function hasLiveWorktreeWriter(root: string): boolean {
  const target = resolve(root)
  for (const scope of liveWriters.values()) {
    if (scope === null || contains(scope, target) || contains(target, scope)) return true
  }
  return false
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
