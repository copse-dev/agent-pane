import { getActiveRunThread } from '../active-run-identity.ts'

/**
 * Session-only, thread-scoped ledger of directories a thread's sandboxed
 * commands may READ in addition to the workspace.
 *
 * Today the only writer is skill invocation (`skill-read-roots.ts`): invoking
 * `/reconcile-worktrees` in a thread makes that skill's directory — and any
 * `paths` its frontmatter declares — readable by `run_shell` for the rest of
 * the thread, so `sed -n 1,80p $SKILL_DIR/SKILL.md` or
 * `cp $SKILL_DIR/scripts/audit.mjs .` no longer ask "Run outside sandbox?".
 * Before this, the skill prompt told the model to use `read_skill` and never
 * `run_shell` for its own files, and a Codex-backed thread — whose only route
 * into Copse's tools is the bridged `run_shell` — hit an approval on every
 * skill file it touched (reconcile-worktrees post-mortem, 2026-09-09).
 *
 * Two consumers must agree on these roots or a command stops prompting and
 * then fails EPERM:
 *
 * - the seatbelt overlay (`project-sandbox/config.ts`) adds each root to
 *   `allowRead` — reads only, never `allowWrite`;
 * - the shell-scope classifier (`shell-guard-environment.ts`) lists them as
 *   contained read roots, so a structurally read-only command naming one is
 *   classified as sandbox-contained rather than as an escape. A non-read-only
 *   command naming a root still prompts, exactly like the chat store mount.
 *
 * Like `read-outside-grant.ts` the ledger lives in memory and dies with the
 * process; nothing here is persisted, and a thread never sees another's roots.
 * Every root is recorded in both the spelling the skill was discovered under
 * and its realpath: the kernel enforces against the canonical path, while the
 * model types the spelling the prompt showed it.
 */
export interface ThreadReadRoot {
  /** Absolute path as discovered / shown to the model (may traverse symlinks). */
  readonly path: string
  /** Realpath of {@link path} — what a seatbelt rule has to name. */
  readonly canonical: string
  /** Whether the root is a directory (`/**` allow) or a single file. */
  readonly isDirectory: boolean
  /** Human-readable origin, for logs and the decision trail. */
  readonly label: string
}

const rootsByThread = new Map<string, Map<string, ThreadReadRoot>>()

export function grantThreadReadRoot(threadId: string, root: ThreadReadRoot): void {
  let roots = rootsByThread.get(threadId)
  if (!roots) {
    roots = new Map()
    rootsByThread.set(threadId, roots)
  }
  roots.set(root.canonical, root)
}

export function threadReadRoots(threadId: string | null): readonly ThreadReadRoot[] {
  if (threadId === null) return []
  const roots = rootsByThread.get(threadId)
  return roots ? [...roots.values()] : []
}

/** Roots granted to the thread whose run is executing on this async chain. */
export function activeThreadReadRoots(): readonly ThreadReadRoot[] {
  return threadReadRoots(getActiveRunThread())
}

/** Absolute spellings (discovered and canonical) of the active thread's roots. */
export function activeThreadReadRootPaths(): string[] {
  const paths = new Set<string>()
  for (const root of activeThreadReadRoots()) {
    paths.add(root.path)
    paths.add(root.canonical)
  }
  return [...paths]
}

/** Drop one thread's roots, or every thread's. For tests and teardown. */
export function clearThreadReadRoots(threadId?: string): void {
  if (threadId === undefined) rootsByThread.clear()
  else rootsByThread.delete(threadId)
}
