/**
 * Deterministic classification of `gh` (GitHub CLI) invocations by argv shape:
 * which subcommand pairs only read, which write to the user's own repository, and
 * which flags a write may carry. Shared by the auto-approval classifier (which
 * turns a `read`/`remote-write` kind into a tier) and the Guarded YOLO harm gate
 * (which lets known reads through and prompts for everything else).
 */

/** What a recognised `gh` invocation does. Unrecognised shapes classify as null. */
export type GhSegmentKind = 'read' | 'remote-write'

export function isFlag(token: string): boolean {
  return token.startsWith('-') && token !== '-'
}

/** The flag name without its `=value` tail, so `--depth=1` matches `--depth`. */
export function flagName(token: string): string {
  const eq = token.indexOf('=')
  return eq === -1 ? token : token.slice(0, eq)
}

/**
 * `gh` subcommand pairs that only read from GitHub. `gh api` is deliberately
 * absent: it can issue any request, including mutations, with no shape this
 * classifier could check.
 */
const GH_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'pr view',
  'pr list',
  'pr diff',
  'pr checks',
  'pr status',
  'issue view',
  'issue list',
  'issue status',
  'run view',
  'run list',
  'repo view',
  'release view',
  'release list',
  'workflow list',
  'workflow view',
  'label list',
  'search prs',
  'search issues',
  'search repos',
  'auth status',
])

/**
 * `gh` subcommand pairs that write to the user's own repository, kept to the
 * additive and reversible ones. Absent on purpose — mirroring `GITHUB_WRITE_TOOLS`
 * in `permission-policy.ts`, which always prompts — are `pr merge`, `pr approve`,
 * `pr ready`, `pr close`, `run rerun`, `workflow run`, `repo delete`, and
 * `release create`: they land code, cast a review, or destroy state.
 */
const GH_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'pr create',
  'pr comment',
  'issue create',
  'issue comment',
])

/**
 * Flags accepted on a `gh` write. Deliberately absent are every file-reading
 * flag (`--body-file`/`-F`, `--template`/`-T`) — which would post the contents of
 * an arbitrary local file to github.com — and `--repo`/`-R`, which would retarget
 * the write away from the workspace's own repository.
 */
const GH_WRITE_FLAGS: ReadonlySet<string> = new Set([
  '--title',
  '-t',
  '--body',
  '-b',
  '--base',
  '-B',
  '--head',
  '-H',
  '--draft',
  '-d',
  '--assignee',
  '-a',
  '--label',
  '-l',
  '--milestone',
  '-m',
  '--fill',
  '--no-maintainer-edit',
])

/**
 * Classify a `gh` invocation. Write subcommands additionally refuse `--repo`/`-R`,
 * so the target is always the repository the workspace's own remote points at
 * rather than an arbitrary one named on the command line.
 *
 * Known limitation: `gh` honours user-defined aliases (`gh alias set pr '!…'`),
 * which live in the user's own `~/.config/gh/` — user-controlled configuration,
 * not repository-controlled, and so outside this classifier's threat model.
 */
export function classifyGhSegment(argv: readonly string[]): GhSegmentKind | null {
  const words = argv.slice(1).filter((token) => !isFlag(token))
  const pair = `${words[0] ?? ''} ${words[1] ?? ''}`.trim()
  if (GH_READ_SUBCOMMANDS.has(pair)) return 'read'
  if (!GH_WRITE_SUBCOMMANDS.has(pair)) return null
  // Writes take an explicit flag allow-list rather than a denylist of `--repo`.
  // The flags that matter are the ones that read a local file and post its
  // contents to github.com — `gh pr create --body-file /etc/passwd` is
  // exfiltration wearing the shape of a PR — and `--repo`/`-R`, which would aim
  // the write at a repository other than the workspace's own.
  const flags = argv.filter(isFlag).map(flagName)
  return flags.every((flag) => GH_WRITE_FLAGS.has(flag)) ? 'remote-write' : null
}
