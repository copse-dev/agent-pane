/**
 * Workspace subtrees that no indexer — and no index-triggering watcher — should
 * descend into: build output, installed dependencies, vendored binaries, VCS
 * metadata, and the ephemeral agent worktrees (each a *full duplicate checkout*
 * of the repo). These mirror the heavy `.gitignore` entries.
 *
 * gortex does NOT honor `.gitignore` (confirmed against v0.58.3 — it is
 * git-aware for history but still walks every file under the tracked path), so
 * without an explicit exclude list it indexes all of the above. On a dev
 * checkout that is ~3 GB, a single `track --wait` never settles inside its
 * window, and the daemon pins the CPU cap indefinitely (#517 follow-up).
 */

/**
 * Patterns handed to `gortex config exclude add`. gortex applies them with
 * `.gitignore` semantics to both indexing and its own file-watcher, so this one
 * list bounds what the daemon builds *and* what re-triggers it.
 */
export const GORTEX_EXCLUDE_PATTERNS = [
  'node_modules/',
  'dist/',
  'dist-test/',
  'dist-types/',
  'dist-test-iso/',
  'vendor/',
  '.git/',
  '.claude/',
] as const

/**
 * Top-level directory names (non-dot) the app-side watcher ignores. Dot-prefixed
 * entries (`.git`, `.claude`, …) are covered by the dotfile rule in
 * {@link isIgnoredWorkspacePath}, matching the file-index walker's convention.
 */
const IGNORED_TOP_LEVEL_DIRS = new Set<string>([
  'node_modules',
  'dist',
  'dist-test',
  'dist-types',
  'dist-test-iso',
  'vendor',
])

/**
 * Whether a workspace-relative path (as reported by `fs.watch`) sits inside a
 * directory the indexers ignore, so a change there should not schedule a
 * rebuild. Matches on the first path segment; dot-prefixed roots are always
 * ignored, mirroring the file-index walker (`file-index.ts`).
 */
export function isIgnoredWorkspacePath(relPath: string): boolean {
  const [first] = relPath.split(/[/\\]/, 1)
  if (!first) return false
  if (first.startsWith('.')) return true
  return IGNORED_TOP_LEVEL_DIRS.has(first)
}
