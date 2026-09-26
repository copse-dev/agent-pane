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
 *
 * When `ruleFor` names the `.gitignore` rule that ignored a dir and that rule is
 * itself an un-anchored basename pattern, the rule is emitted instead of the
 * dir's name. Uniquely-named scratch dirs (`.wdio-profile-0K8Umz/`, one per e2e
 * run) then collapse to the single `.wdio-profile-*\/` glob instead of adding a
 * pattern per run: gortex matches every watcher event against every pattern, so
 * 870 such names cut its event throughput to ~550 events/s and let checkout
 * churn overflow its event queue into full-tree reconciles.
 *
 * With `ruleFor`, a dir no rule ignores is skipped: `--directory` also lists an
 * untracked dir whose contents are all ignored (`assets/icons/wave/` holding
 * only a `.DS_Store`), and its bare name would exclude every `wave/` in the
 * workspace. Its ignored subdirs are listed, and handled, on their own lines.
 */
export function deriveExcludePatterns(
  ignoredPaths: Iterable<string>,
  ruleFor?: ReadonlyMap<string, string>,
): string[] {
  const names = new Set<string>()
  for (const raw of ignoredPaths) {
    const path = raw.trim()
    // git emits a trailing slash for directories with `--directory`.
    if (!path || !path.endsWith('/')) continue
    if (ruleFor) {
      const rule = ruleFor.get(path)
      if (rule === undefined) continue
      if (isBasenameRule(rule)) {
        names.add(rule)
        continue
      }
    }
    const name = path.replace(/\/+$/, '').split('/').pop()
    if (name && name !== '.' && name !== '..') names.add(`${name}/`)
  }
  return [...names].sort()
}

/**
 * Whether a `.gitignore` rule matches by basename at any depth — no negation, no
 * anchoring slash — so it keeps git's meaning when handed to gortex unchanged.
 */
function isBasenameRule(rule: string): boolean {
  if (!rule || rule.startsWith('!') || rule.startsWith('#') || rule.startsWith('\\')) return false
  const body = rule.endsWith('/') ? rule.slice(0, -1) : rule
  return body !== '' && !body.includes('/') && !/\s$/.test(body)
}

/**
 * Parse `git check-ignore -v -z` output — `source NUL line NUL pattern NUL path
 * NUL` per ignored path — into path → the rule that ignored it.
 */
export function parseCheckIgnoreRules(stdout: string): Map<string, string> {
  const fields = stdout.split('\0')
  const rules = new Map<string, string>()
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const pattern = fields[i + 2]
    const path = fields[i + 3]
    if (pattern && path) rules.set(path, pattern)
  }
  return rules
}

/**
 * Single-segment gitignore glob → anchored regex, or null for anything this
 * does not model (so the caller treats it as covering nothing). Supports `*`,
 * `?`, `[…]` classes and `\`-escapes — the syntax a basename rule can use.
 */
function basenameGlobRegex(glob: string): RegExp | null {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i)
    if (ch === '*') source += '[^/]*'
    else if (ch === '?') source += '[^/]'
    else if (ch === '\\') {
      const next = glob.charAt(++i)
      if (!next) return null
      source += next.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    } else if (ch === '[') {
      const end = glob.indexOf(']', i + 2)
      if (end === -1) return null
      const body = glob
        .slice(i + 1, end)
        .replace(/^!/, '^')
        .replace(/\\/g, '\\\\')
      source += `[${body}]`
      i = end
    } else source += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  }
  try {
    return new RegExp(`^${source}$`)
  } catch {
    return null
  }
}

/**
 * Literal basename patterns (`.wdio-profile-0K8Umz/`) already covered by a
 * wildcard basename pattern in the same list (`.wdio-profile-*\/`). They were
 * written by builds of {@link deriveExcludePatterns} that emitted instance names,
 * and cost gortex a regex match per watcher event while excluding nothing extra.
 * A directory-only wildcard (`name/`) covers only directory entries.
 */
export function redundantExcludePatterns(patterns: Iterable<string>): string[] {
  const list = [...patterns]
  const covers = list
    .filter((p) => isBasenameRule(p) && /[*?[]/.test(p))
    .flatMap((p) => {
      const dirOnly = p.endsWith('/')
      const regex = basenameGlobRegex(dirOnly ? p.slice(0, -1) : p)
      return regex ? [{ regex, dirOnly }] : []
    })
  if (covers.length === 0) return []
  return list.filter((p) => {
    if (!isBasenameRule(p) || /[*?[\\]/.test(p)) return false
    const isDir = p.endsWith('/')
    const name = isDir ? p.slice(0, -1) : p
    return covers.some((c) => (isDir || !c.dirOnly) && c.regex.test(name))
  })
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

// Cap stdout: `git status --ignored` / the repo-scan `find` can list the entire
// ignored tree (all of node_modules, dist*, build output) — tens of MB — but we
// only collapse it to a handful of directory-name patterns, so an 8 MB sample is
// plenty. Without a cap the full list is buffered and re-scanned per chunk.
const GIT_CMD_OPTS = {
  unsandboxed: true,
  timeout_ms: 60_000,
  lowPriority: true,
  stdoutMaxBytes: 8 * 1024 * 1024,
} as const

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
 * The `.gitignore` rule behind each ignored directory, keyed by the
 * repo-relative path `ignoredEntriesFor` reported. Undefined when git could not
 * answer, which falls back to per-directory names.
 */
async function ignoreRulesFor(
  repoRoot: string,
  entries: string[],
): Promise<Map<string, string> | undefined> {
  const dirs = entries.map((e) => e.trim()).filter((e) => e.endsWith('/'))
  if (dirs.length === 0) return new Map()
  try {
    const { stdout, code } = await runCommand('git', ['check-ignore', '-v', '-z', '--stdin'], {
      cwd: repoRoot,
      ...GIT_CMD_OPTS,
      stdin: Buffer.from(`${dirs.join('\0')}\0`),
    })
    // 0: some paths matched, 1: none did; anything else is a git failure.
    return code === 0 || code === 1 ? parseCheckIgnoreRules(stdout) : undefined
  } catch {
    return undefined
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
  const patterns = new Set<string>()
  for (const repo of repos) {
    const ignored = await ignoredEntriesFor(repo)
    const rules = await ignoreRulesFor(repo, ignored)
    for (const pattern of deriveExcludePatterns(ignored, rules)) patterns.add(pattern)
  }
  return [...patterns].sort()
}
