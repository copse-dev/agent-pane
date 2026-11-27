import { classifyGhSegment, isFlag, flagName } from '@copse/shell-guard/gh-argv.ts'
import { splitSegments } from './command-routing.ts'
import {
  argvOf,
  effectiveArgv,
  isNetworkCloneSource,
  splitGitArgv,
  stripClearedRedirects,
} from './auto-approval.ts'
import type { RepoNetworkFacts } from './git-network-facts.ts'
import { INTERNAL_GIT_CONFIG } from './git-invocation.ts'

/**
 * Per-command network scope: which hosts ONE contained command may reach.
 *
 * Contained commands get no network (`containedSandboxNetworkConfig`). The most
 * common commands that need it are a handful of recognised shapes — `git fetch
 * origin main`, `gh run view`, `git push origin <branch>` — whose destination is
 * knowable before they run. Rather than leave the sandbox to reach that one host,
 * such a command runs contained in its own ASRT host process with an allowlist of
 * exactly that host (`project-sandbox/port-binding-worker.ts`). ASRT's allowlist
 * is process-global, so a separate process is the only way to keep the egress
 * from every other contained command (`docs/plans/sandbox-network-scope-isolation.md`).
 *
 * This module only answers "which hosts, if any". Whether the command may run at
 * all is still the permission gate's call: the harm gate must allow it and the
 * auto-approval classifier must place it in a tier the user enabled
 * (`scopedNetworkRunFor` in `permission-gate.ts`). The plan is never a session
 * allowlist: it lives exactly as long as the command's process.
 *
 * WHY THE HOSTS ARE SAFE TO OPEN. Every host here accepts writes from anyone with
 * a token — GitHub takes a gist, a registry takes a publish. So the property that
 * matters is not the host but that nothing except the recognised tool runs while
 * the egress is open:
 *
 *  - every segment is itself a recognised network shape (a git network
 *    subcommand or a `gh` read) or one of a few output filters
 *    ({@link INERT_FILTERS}) that can neither reach the network nor run another
 *    program. The allowlist applies to the whole spawn, so any other program in
 *    the line — `python3 -c urlopen(...)`, `curl`, `security verify-cert` —
 *    would hold the same egress;
 *  - every program must be named bare, with no wrapper or environment
 *    assignment, and resolve outside the workspace (checked by the caller), so a
 *    planted `./git` or `./tail` cannot take its place;
 *  - the repository's config and hooks are write-protected from contained
 *    commands, and config that names a program, includes another file or points
 *    hooks into the workspace refuses the scope ({@link RepoNetworkFacts});
 *  - a `cd` refuses the scope, since git discovers its repository from the
 *    working directory and a contained command can plant one anywhere it writes.
 *
 * Lockfile installs are deliberately not a shape yet: `pnpm`'s `.pnpmfile.cjs`
 * and Yarn's `yarnPath`/plugins run repository code inside the install, which
 * would hold registry egress.
 */

export const GITHUB_DOMAINS: readonly string[] = [
  'github.com',
  'api.github.com',
  // Run logs, release assets and raw content redirect here.
  '*.githubusercontent.com',
]

export interface ScopedNetworkPlan {
  /** Hosts the command's ASRT host may reach; nothing else. Sorted, deduplicated. */
  domains: string[]
  /** A `gh` command, or git against github.com: the GitHub token may be supplied. */
  github: boolean
  /** No segment runs git hooks on purpose (fetch, ls-remote, clone): disable them. */
  disableGitHooks: boolean
  /**
   * For a push, the hooks directory judged safe at the gate, passed back to git
   * at execution time so a config rewrite after the check cannot move it.
   */
  hooksPath: string | null
  /** Short human-readable reasons, for the decision log. */
  reasons: string[]
  /** Bare program names the caller must resolve outside every writable root. */
  programs: string[]
  /**
   * The line is one `gh` read and nothing else but {@link INERT_FILTERS}: the
   * only shape given macOS's `com.apple.trustd.agent` lookup, which Go needs to
   * verify TLS. trustd fetches a certificate's AIA and OCSP URLs itself, outside
   * the sandbox and its proxy, so any program that can hand it a certificate
   * has a way to any host. `gh` only ever verifies the chains GitHub serves.
   */
  trustEvaluation: boolean
  /** Remotes a push segment publishes to; the gate checks their outgoing commits for secrets. */
  pushRemotes: string[]
}

/**
 * Programs that may share a network-scoped line, typically after a pipe
 * (`gh run view 1 --log-failed | tail -50`). Each reads text and writes text:
 * none opens a socket, runs another program or evaluates a certificate. Absent
 * on purpose: `sed` (GNU `e` runs a shell command), `awk` (`system()`), `sort`
 * (`--compress-program`), `xargs`, `jq` and anything else that could.
 */
const INERT_FILTERS: ReadonlySet<string> = new Set([
  'cat',
  'head',
  'tail',
  'grep',
  'wc',
  'uniq',
  'cut',
  'tr',
])

export type ScopedNetworkAssessment =
  | { action: 'scope'; plan: ScopedNetworkPlan }
  | { action: 'none'; reason: string }

const DNS_HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/**
 * The host a git remote URL reaches, or null when it is not a network URL git
 * would reach over HTTPS or SSH by name. IP literals and single-label names are
 * refused: they address local or private services, never a forge.
 */
export function gitUrlHost(url: string): string | null {
  const trimmed = url.trim()
  if (trimmed.includes('::')) return null
  let host: string | null = null
  const scheme =
    /^(?:https|ssh|git\+ssh|ssh\+git):\/\/(?:[^@/\s]+@)?(\[[^\]]+\]|[^/:\s]+)(?::\d+)?(?:\/|$)/i.exec(
      trimmed,
    )
  if (scheme) host = scheme[1] ?? null
  else {
    // scp-like `user@host:path`. Git reads `host:path` the same way, but only
    // with a user part is it unambiguous from a local path containing a colon.
    const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/\/)\S+$/.exec(trimmed)
    if (scp) host = scp[1] ?? null
  }
  if (host === null) return null
  host = host.toLowerCase()
  if (!DNS_HOST.test(host)) return null
  if (/^\d+(?:\.\d+){3}$/.test(host)) return null
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null
  return host
}

interface SegmentScope {
  hosts: string[]
  /** For a push: the remotes it may publish to. */
  pushRemotes?: string[]
  github: boolean
  runsHooks: boolean
  /** Programs the segment runs by PATH lookup; `gh` also runs `git`. */
  programs: string[]
  reason: string
}

function remoteHosts(
  facts: RepoNetworkFacts,
  name: string | null,
  push: boolean,
): string[] | { refused: string } {
  const unvouched = facts.unvouchedRemotes ?? new Map<string, string>()
  const names = name === null ? [...facts.remotes.keys(), ...unvouched.keys()] : [name]
  if (names.length === 0) return { refused: 'no configured remote' }
  for (const remote of names) {
    const reason = unvouched.get(remote)
    if (reason !== undefined) return { refused: reason }
  }
  const hosts: string[] = []
  for (const remote of names) {
    const urls = facts.remotes.get(remote)
    if (!urls) return { refused: `remote ${remote} is not configured` }
    const url = push ? (urls.pushUrl ?? urls.url) : urls.url
    if (url === null) return { refused: `remote ${remote} has no URL` }
    const host = gitUrlHost(url)
    if (host === null) return { refused: `remote ${remote} is not on a named network host` }
    hosts.push(host)
  }
  return hosts
}

/**
 * The first positional argument of a fetch/pull/push/ls-remote — the remote or
 * URL git will contact — or null for the implicit upstream. A URL or unknown
 * name is returned as is, so the caller refuses it rather than planning the
 * configured remotes' hosts for a command that would contact another.
 */
function namedRemote(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    const token = args[index] ?? ''
    if (isFlag(token)) {
      if (['--depth', '--deepen'].includes(flagName(token)) && !token.includes('=')) index++
      continue
    }
    return token
  }
  return null
}

function gitSegmentScope(
  argv: readonly string[],
  facts: RepoNetworkFacts | null,
): SegmentScope | { refused: string } {
  const split = splitGitArgv(argv)
  if (!split) return { refused: 'unrecognised git global option' }
  const { subcommand, args } = split
  if (subcommand === 'clone') {
    const source = args.find((token, index) => {
      if (isFlag(token)) return false
      const previous = args[index - 1] ?? ''
      const valued = ['--depth', '--branch', '-b', '--filter']
      return !(valued.includes(previous) && !previous.includes('='))
    })
    if (source === undefined || !isNetworkCloneSource(source)) {
      return { refused: 'git clone source is not a network URL' }
    }
    const host = gitUrlHost(source)
    if (host === null) return { refused: 'git clone source is not on a named network host' }
    // A clone may reach a forge or a host the user already configured as a
    // remote; any other host is a destination the model chose, and its path is
    // a channel to that host's logs.
    const known = new Set(['github.com'])
    for (const urls of facts?.remotes.values() ?? []) {
      for (const url of [urls.url, urls.pushUrl]) {
        const remoteHost = url === null ? null : gitUrlHost(url)
        if (remoteHost) known.add(remoteHost)
      }
    }
    if (!known.has(host))
      return { refused: `git clone from ${host}, which is not a configured remote host` }
    return {
      hosts: [host],
      github: host === 'github.com',
      runsHooks: false,
      programs: ['git'],
      reason: `git clone reaches ${host}`,
    }
  }
  // Not `pull`: its merge checks out files, which runs the repository's filter
  // drivers and merge hooks, none of which an execution-time override can name.
  if (!['fetch', 'push', 'ls-remote'].includes(subcommand)) {
    return { refused: `git ${subcommand} is not a network shape` }
  }
  if (facts === null) return { refused: 'the execution root is not the project repository' }
  const push = subcommand === 'push'
  const remote = namedRemote(args)
  const hosts = remoteHosts(facts, remote, push)
  if (!Array.isArray(hosts)) return hosts
  return {
    hosts,
    ...(push ? { pushRemotes: remote === null ? [...facts.remotes.keys()] : [remote] } : {}),
    github: hosts.includes('github.com'),
    runsHooks: push,
    programs: ['git'],
    reason: `git ${subcommand} reaches ${[...new Set(hosts)].join(', ')}`,
  }
}

function ghSegmentScope(argv: readonly string[]): SegmentScope | { refused: string } {
  // Only reads. A write (`pr create`, `release create`, `gist create`) asks
  // through the harm gate anyway; refusing it here as well keeps the egress
  // from ever being opened for one if that gate changes.
  if (classifyGhSegment(argv) !== 'read') return { refused: 'gh command is not a read' }
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index] ?? ''
    const name = flagName(token)
    if (name !== '--repo' && name !== '-R' && name !== '--hostname') continue
    const value = token.includes('=') ? token.slice(name.length + 1) : argv[index + 1]
    if (value === undefined) return { refused: `gh ${name} has no value` }
    // `HOST/OWNER/REPO` and `--hostname` aim gh at another GitHub instance.
    if (name === '--hostname' ? value !== 'github.com' : value.split('/').length > 2) {
      if (!value.startsWith('github.com/'))
        return { refused: 'gh targets a host other than github.com' }
    }
  }
  return {
    hosts: [...GITHUB_DOMAINS],
    github: true,
    runsHooks: false,
    // gh finds its repository by running `git` from PATH.
    programs: ['gh', 'git'],
    reason: `gh ${argv.slice(1, 3).join(' ')} reaches GitHub`,
  }
}

/**
 * Plan the network scope for `command`, which the caller has already found to be
 * an auto-approved shape. Pure: the caller supplies the repository facts read for
 * the execution root (null when it is not the project's protected repository).
 */
export function planScopedNetwork(
  command: string,
  facts: RepoNetworkFacts | null,
): ScopedNetworkAssessment {
  const segments = splitSegments(command.trim())
  if (segments.length === 0) return { action: 'none', reason: 'no segments' }
  const scopes: SegmentScope[] = []
  const filters = new Set<string>()
  for (const segment of segments) {
    const argv = argvOf(stripClearedRedirects(segment))
    if (!argv) return { action: 'none', reason: `unparseable segment: ${segment}` }
    const effective = effectiveArgv(argv)
    const head = effective?.[0]
    if (!effective || head === undefined)
      return { action: 'none', reason: `no command word: ${segment}` }
    // A wrapper (`env`, `command`, `nice`) is one more program holding the egress.
    if (effective.length !== argv.length)
      return { action: 'none', reason: `wrapped command: ${segment}` }
    const name = head.slice(head.lastIndexOf('/') + 1)
    if (name === 'cd' || name === 'pushd' || name === 'popd') {
      return { action: 'none', reason: 'changes directory, so git may find another repository' }
    }
    if (head.includes('/')) return { action: 'none', reason: `${name} is named by path` }
    if (INERT_FILTERS.has(name)) {
      filters.add(name)
      continue
    }
    if (name !== 'git' && name !== 'gh') {
      // The allowlist covers the whole spawn: any other program could use it.
      return { action: 'none', reason: `${name} would share the network scope` }
    }
    // gh runs git in whatever repository it discovers, so it needs the same
    // vouched-for repository a git network command does.
    if (name === 'gh' && facts === null) {
      return { action: 'none', reason: 'the execution root is not the project repository' }
    }
    const scope = name === 'git' ? gitSegmentScope(effective, facts) : ghSegmentScope(effective)
    if ('refused' in scope) return { action: 'none', reason: scope.refused }
    scopes.push(scope)
  }
  if (scopes.length === 0) return { action: 'none', reason: 'no network command' }
  // gh also runs git (`git remote -v`, `git status`) to find its repository.
  if (facts !== null && facts.unsafeConfig.length > 0) {
    return { action: 'none', reason: `repository config: ${facts.unsafeConfig.join('; ')}` }
  }
  const runsHooks = scopes.some((scope) => scope.runsHooks)
  if (runsHooks && facts?.workspaceHooks === true) {
    return { action: 'none', reason: 'git hooks run from a directory contained commands can write' }
  }
  const hooksPath = runsHooks ? (facts?.hooksPath ?? null) : null
  if (runsHooks && hooksPath === null) {
    return { action: 'none', reason: 'the hooks directory is not write-protected' }
  }
  return {
    action: 'scope',
    plan: {
      domains: [...new Set(scopes.flatMap((scope) => scope.hosts))].sort(),
      github: scopes.some((scope) => scope.github),
      disableGitHooks: !runsHooks,
      hooksPath,
      reasons: scopes.map((scope) => scope.reason),
      programs: [...new Set([...scopes.flatMap((scope) => scope.programs), ...filters])].sort(),
      trustEvaluation: scopes.length === 1 && scopes[0]?.programs[0] === 'gh',
      pushRemotes: [...new Set(scopes.flatMap((scope) => scope.pushRemotes ?? []))].sort(),
    },
  }
}

/**
 * Git config every scoped git run gets at execution time. A shared checkout's
 * `.git/config` is writable by contained commands, so the gate's scan
 * ({@link RepoNetworkFacts}) is only advisory there: a background task can
 * rewrite the config between the scan and git's own read. These entries outrank
 * every config file and switch off the keys that make fetch or push run a
 * program — the same set internal git uses (`INTERNAL_GIT_CONFIG`), with hooks
 * handled per plan. Submodule recursion is off so no other repository's config
 * is read.
 */
const SCOPED_GIT_OVERRIDES: ReadonlyArray<[string, string]> = [
  ...INTERNAL_GIT_CONFIG.filter((entry) => !entry.startsWith('core.hooksPath=')).map(
    (entry): [string, string] => {
      const eq = entry.indexOf('=')
      return [entry.slice(0, eq), entry.slice(eq + 1)]
    },
  ),
  // `true` (a shell builtin) lists no alternate refs; an empty value makes some
  // git versions print "cannot run".
  ['core.alternateRefsCommand', 'true'],
  ['core.askPass', ''],
  ['fetch.recurseSubmodules', 'false'],
  ['push.recurseSubmodules', 'no'],
]

/** The empty tree: attributes read from it name no filter driver. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * Environment for a network-scoped command. Git config travels as
 * `GIT_CONFIG_COUNT` entries, which outrank every config file.
 *
 *  - {@link SCOPED_GIT_OVERRIDES} neutralise program-running config, and
 *    `GIT_ALLOW_PROTOCOL` limits transports to HTTPS and SSH, which refuses
 *    `ext::`, `file://` and every remote helper a `remote.*.vcs` could name.
 *    `GIT_SSH_COMMAND` and `GIT_ASKPASS` outrank `core.sshCommand` and
 *    `core.askPass`.
 *  - Hooks are switched off for shapes that never mean to run one. A push gets
 *    the hooks directory the gate judged write-protected, pinned here.
 *  - With a GitHub token: SSH remotes on github.com are rewritten to HTTPS (the
 *    contained process cannot read `~/.ssh`), and a credential helper that only
 *    answers from `GH_TOKEN` replaces every configured one for github.com.
 *  - gh is given a fresh config directory by the spawn (`freshGhConfig`): the
 *    contained process cannot read `~/.config/gh`, and gh fails rather than
 *    starting empty when that read is denied. Its own `git` calls read
 *    attributes from the empty tree, so no filter driver can run.
 */
export function scopedNetworkEnv(
  plan: ScopedNetworkPlan,
  options: { githubToken: string | null },
): Record<string, string> {
  const config: Array<[string, string]> = [...SCOPED_GIT_OVERRIDES]
  config.push([
    'core.hooksPath',
    plan.disableGitHooks ? '/dev/null' : (plan.hooksPath ?? '/dev/null'),
  ])
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'https:ssh',
    // Absolute, so a planted `ssh` earlier on PATH cannot stand in.
    GIT_SSH_COMMAND: '/usr/bin/ssh',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false',
  }
  // An empty helper resets the list collected from every config file. The
  // user's helpers (osxkeychain, store) cannot reach their stores from inside
  // the sandbox anyway; left in place they only fail noisily after each fetch.
  config.push(['credential.helper', ''])
  if (plan.github && options.githubToken !== null) {
    env['GH_TOKEN'] = options.githubToken
    config.push(
      ['url.https://github.com/.insteadOf', 'git@github.com:'],
      ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
      [
        'credential.https://github.com.helper',
        '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f',
      ],
    )
  }
  if (plan.programs.includes('gh')) {
    // GH_CONFIG_DIR is set by the spawn, inside the command's own temp directory.
    env['GH_PROMPT_DISABLED'] = '1'
    env['GH_NO_UPDATE_NOTIFIER'] = '1'
    env['GIT_ATTR_SOURCE'] = EMPTY_TREE
  }
  env['GIT_CONFIG_COUNT'] = String(config.length)
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${String(index)}`] = key
    env[`GIT_CONFIG_VALUE_${String(index)}`] = value
  })
  return env
}
