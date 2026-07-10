import { runCommand } from '../exec/command-runner.ts'

/**
 * gortex does not honor `.gitignore`, so pointed at a repo it walks every file
 * under the tree — including nested build output that git ignores. On a real
 * checkout that dwarfs the source (observed: a workspace with 13k tracked files
 * but 235k gitignored ones — SwiftPM `.build`/`.swiftpm`, Xcode `DerivedData`,
 * etc.), and indexing it pins the CPU (#517 follow-up).
 *
 * Rather than ship a hardcoded list of ecosystem build dirs (endless
 * whack-a-mole), derive the ignore set from git itself: git already knows what's
 * junk. This handles any language's build output for free, and updates itself as
 * conventions change.
 */

/** Perf-only: dirs we never descend into while *discovering* nested repos. Not a
 * correctness list — git supplies the real excludes; this just keeps the `.git`
 * walk from diving through hundreds of thousands of build-output files. (`.git`
 * is handled separately: it's pruned *and printed*, not skipped.) */
const REPO_SCAN_PRUNE_DIRS = ['node_modules', '.build', '.swiftpm', 'DerivedData']

/** Bound the nested-repo scan so a pathological tree can't make discovery run away. */
const REPO_SCAN_MAX_DEPTH = 8

/**
 * Collapse git's ignored-path list into a small set of gitignore-semantics
 * patterns for gortex. Only *directories* are collapsed (they hold the bulk —
 * build output); individual ignored files are left alone (cheap to index, and
 * collapsing a filename like `api.html` to a bare pattern would over-match).
 * Each ignored dir becomes an un-anchored `name/` pattern, so one `.build/`
 * covers every package's `.build` at any depth — turning hundreds of anchored
 * paths into a handful of patterns.
 */
export function deriveExcludePatterns(ignoredPaths: Iterable<string>): string[] {
  const names = new Set<string>()
  for (const raw of ignoredPaths) {
    const path = raw.trim()
    // git emits a trailing slash for directories with `--directory`.
    if (!path || !path.endsWith('/')) continue
    const name = path.replace(/\/+$/, '').split('/').pop()
    if (name && name !== '.' && name !== '..') names.add(`${name}/`)
  }
  return [...names].sort()
}

/** Parse `find … -name .git` output into the repo roots (the parent of each `.git`). */
export function repoRootsFromGitDirs(findOutput: string): string[] {
  const roots = new Set<string>()
  for (const line of findOutput.split('\n')) {
    const gitDir = line.trim()
    if (!gitDir) continue
    // Strip a trailing `/.git` (dir) — nested repos always have one.
    const root = gitDir.replace(/\/\.git\/?$/, '')
    if (root) roots.add(root)
  }
  return [...roots]
}

const GIT_CMD_OPTS = { unsandboxed: true, timeout_ms: 60_000, lowPriority: true } as const

/** Discover every git repo under the workspace (the root, plus embedded repos). */
async function findGitRepos(workspaceRoot: string): Promise<string[]> {
  const roots = new Set<string>()
  if (await isGitRepo(workspaceRoot)) roots.add(workspaceRoot)

  // Standard "find repos without descending into them" idiom: prune the giant
  // build-output dirs outright, and for a `.git` dir, `-prune -print` reports it
  // but stops the walk from entering repo internals. Failure (e.g. no `find`)
  // just yields the root repo.
  const args = [
    workspaceRoot,
    '-maxdepth',
    String(REPO_SCAN_MAX_DEPTH),
    '(',
    ...REPO_SCAN_PRUNE_DIRS.flatMap((d, i) => (i === 0 ? ['-name', d] : ['-o', '-name', d])),
    ')',
    '-prune',
    '-o',
    '-type',
    'd',
    '-name',
    '.git',
    '-prune',
    '-print',
  ]
  try {
    const { stdout } = await runCommand('find', args, GIT_CMD_OPTS)
    for (const root of repoRootsFromGitDirs(stdout)) roots.add(root)
  } catch {
    // find unavailable / errored — the root repo alone still gets excludes.
  }
  return [...roots]
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const { code } = await runCommand('git', ['rev-parse', '--git-dir'], {
      cwd: dir,
      ...GIT_CMD_OPTS,
    })
    return code === 0
  } catch {
    return false
  }
}

/** Ignored directories git reports for a single repo (collapsed via `--directory`). */
async function ignoredEntriesFor(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await runCommand(
      'git',
      ['ls-files', '--others', '--ignored', '--directory', '--exclude-standard'],
      { cwd: repoRoot, ...GIT_CMD_OPTS },
    )
    return stdout.split('\n')
  } catch {
    return []
  }
}

/**
 * Compute the gortex exclude patterns for a workspace by unioning every
 * contained repo's git-ignored directories. Returns a small, deduped,
 * gitignore-semantics pattern list (empty if there are no git repos / no
 * ignored dirs).
 */
export async function computeGitIgnoreExcludes(workspaceRoot: string): Promise<string[]> {
  const repos = await findGitRepos(workspaceRoot)
  if (repos.length === 0) return []
  const ignored: string[] = []
  for (const repo of repos) ignored.push(...(await ignoredEntriesFor(repo)))
  return deriveExcludePatterns(ignored)
}
