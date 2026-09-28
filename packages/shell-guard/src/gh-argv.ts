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
 * `gh` subcommand pairs that only read from GitHub. `gh api` is classified
 * separately by {@link isGhApiRead}: it can issue any request, so only the
 * narrow GET shape counts as a read.
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
 * `gh api` flags that change only how a GET's response is shown or paged. Any
 * other flag — a method, a field (`-f`/`-F`, which turn the request into a POST),
 * `--input`, or a header (which could carry `X-HTTP-Method-Override`) — leaves
 * the call unclassified.
 */
const GH_API_READ_SWITCHES: ReadonlySet<string> = new Set([
  '--paginate',
  '--slurp',
  '--include',
  '-i',
  '--silent',
  '--verbose',
])
const GH_API_READ_VALUED: ReadonlySet<string> = new Set([
  '--jq',
  '-q',
  '--template',
  '-t',
  '--cache',
  '--hostname',
])
const GH_API_METHOD_FLAGS: ReadonlySet<string> = new Set(['--method', '-X'])

/**
 * Whether a `gh api` call is a plain GET of a REST endpoint. `gh api` defaults to
 * GET and switches to POST the moment a field is added, so the shape to accept is
 * narrow: one endpoint, no body, and either no method or an explicit `GET`.
 * `graphql` is excluded — it is always a POST, and a mutation reads exactly like
 * a query to anything short of a GraphQL parser.
 */
function isGhApiRead(args: readonly string[]): boolean {
  let endpoint: string | null = null
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? ''
    if (!isFlag(token)) {
      if (endpoint !== null) return false
      endpoint = token
      continue
    }
    const name = flagName(token)
    const attached = token.length > name.length
    if (GH_API_READ_SWITCHES.has(name) && !attached) continue
    const valued = GH_API_READ_VALUED.has(name) || GH_API_METHOD_FLAGS.has(name)
    if (!valued) return false
    const value = attached ? token.slice(name.length + 1) : args[++i]
    if (value === undefined) return false
    if (GH_API_METHOD_FLAGS.has(name) && value.toUpperCase() !== 'GET') return false
  }
  // A full URL can name any host; `gh` sends the user's token to hosts it knows.
  return endpoint !== null && endpoint !== 'graphql' && !endpoint.includes('://')
}

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
  if (argv[1] === 'api') return isGhApiRead(argv.slice(2)) ? 'read' : null
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
