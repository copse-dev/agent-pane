/**
 * The pure half of sandboxed GitHub reads (`sandbox-github-reads.ts`): the
 * names, the configuration a sandboxed `gh` and `git` are given, and the
 * per-session credential check. No I/O.
 *
 * Route, in brief (docs/shell-permissions.md, "GitHub reads in the sandbox"):
 * - `git` rewrites github.com remotes (https, scp-style and ssh) to a
 *   per-session plain-HTTP alias, `s<id>.github.copse.internal`, through
 *   `GIT_CONFIG_*` variables. The project sandbox already sends a contained
 *   command's HTTP through ASRT's own proxy; Copse names the alias in that
 *   proxy's allowlist and routes it (ASRT `mitmProxy`) to a Copse-owned unix
 *   socket. Works under macOS Seatbelt and Linux bubblewrap alike.
 * - `gh` (macOS only) is pointed at a per-session unix socket by
 *   `http_unix_socket` in a Copse-owned `GH_CONFIG_DIR`; the spawn's Seatbelt
 *   profile allows connecting to that one socket path. Linux bubblewrap blocks
 *   every `AF_UNIX` socket with seccomp, so `gh` keeps today's behaviour there.
 *
 * Every request must carry the session's secret: gh sends it from hosts.yml
 * as `Authorization`, git as {@link SANDBOX_GITHUB_SESSION_HEADER} from
 * `http.<alias>.extraHeader`. Nothing here ever writes the user's own git or
 * gh configuration.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { GITHUB_GIT_ALIAS_HOST } from '../container-runtime/github-capability-wire.ts'

/** The header git sends the session secret in. */
export const SANDBOX_GITHUB_SESSION_HEADER = 'X-Copse-GitHub-Session'

/** The alias label for one session: `s` and 16 hex characters. */
const SESSION_LABEL = /^s[0-9a-f]{16}$/

/** The alias host git is rewritten to for one session. */
export function sessionAliasHost(sessionId: string): string {
  if (!SESSION_LABEL.test(sessionId)) throw new Error('malformed sandbox GitHub session id')
  return `${sessionId}.${GITHUB_GIT_ALIAS_HOST}`
}

/** The session id named by an alias host, or null when it names no session. */
export function sessionIdFromAliasHost(host: string): string | null {
  const suffix = `.${GITHUB_GIT_ALIAS_HOST}`
  const lower = host.toLowerCase()
  if (!lower.endsWith(suffix)) return null
  const label = lower.slice(0, -suffix.length)
  return SESSION_LABEL.test(label) ? label : null
}

/** ASRT allowlist entry: any session alias, plain HTTP on port 80 only. */
export const SANDBOX_GITHUB_PROXY_DOMAIN = `*.${GITHUB_GIT_ALIAS_HOST}:80`
/** ASRT `mitmProxy` domain pattern routed to the git socket. */
export const SANDBOX_GITHUB_MITM_DOMAIN = `*.${GITHUB_GIT_ALIAS_HOST}`

/** The environment variables gh would prefer over hosts.yml; unset in the sandbox. */
const GH_ENV_OVERRIDES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
] as const

/**
 * The `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` pairs that send this session's
 * GitHub traffic to its alias. Appended after any the environment already
 * carries, so nothing set by the caller is overwritten.
 */
export function sandboxGitConfigEntries(
  aliasHost: string,
  secret: string,
): Array<[key: string, value: string]> {
  const base = `http://${aliasHost}/`
  return [
    [`url.${base}.insteadOf`, 'https://github.com/'],
    [`url.${base}.insteadOf`, 'git@github.com:'],
    [`url.${base}.insteadOf`, 'ssh://git@github.com/'],
    [`http.${base}.extraHeader`, `${SANDBOX_GITHUB_SESSION_HEADER}: ${secret}`],
    // An empty helper clears the list for the alias: the user's keychain
    // helper has nothing for it and cannot be written from the sandbox.
    [`credential.${base}.helper`, ''],
  ]
}

function existingGitConfigCount(env: NodeJS.ProcessEnv): number {
  const raw = env['GIT_CONFIG_COUNT']
  if (raw === undefined || !/^\d{1,4}$/.test(raw)) return 0
  return Number(raw)
}

export interface SandboxGitHubEnvInput {
  aliasHost: string
  secret: string
  /** The session's gh configuration directory, or null where gh is not routed. */
  ghConfigDir: string | null
}

/**
 * The variables a sandboxed command gets on top of `env`. `undefined` means
 * unset: Node's spawn skips such keys, so a host `GH_TOKEN` cannot take
 * precedence over the session's hosts.yml.
 */
export function sandboxGitHubEnv(
  env: NodeJS.ProcessEnv,
  input: SandboxGitHubEnvInput,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  const start = existingGitConfigCount(env)
  const entries = sandboxGitConfigEntries(input.aliasHost, input.secret)
  entries.forEach(([key, value], index) => {
    out[`GIT_CONFIG_KEY_${String(start + index)}`] = key
    out[`GIT_CONFIG_VALUE_${String(start + index)}`] = value
  })
  out['GIT_CONFIG_COUNT'] = String(start + entries.length)
  if (input.ghConfigDir !== null) {
    for (const key of GH_ENV_OVERRIDES) out[key] = undefined
    out['GH_CONFIG_DIR'] = input.ghConfigDir
    out['GH_PROMPT_DISABLED'] = '1'
    out['GH_NO_UPDATE_NOTIFIER'] = '1'
  }
  return out
}

/** The two files written into the session's `GH_CONFIG_DIR`. */
export function sandboxGhConfigFiles(input: {
  socketPath: string
  secret: string
}): Record<'config.yml' | 'hosts.yml', string> {
  return {
    'config.yml': [
      '# Written by Copse for sandboxed commands in one thread. gh sends every',
      '# request to Copse over this socket; Copse reads GitHub with your sign-in.',
      `http_unix_socket: ${JSON.stringify(input.socketPath)}`,
      'git_protocol: https',
      'prompt: disabled',
      '',
    ].join('\n'),
    'hosts.yml': [
      'github.com:',
      `    oauth_token: ${JSON.stringify(input.secret)}`,
      '    git_protocol: https',
      '',
    ].join('\n'),
  }
}

/** Constant-time equality for two secrets of any length. */
export function sameSecret(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b) && presented.length === expected.length
}

/** The secret a request presents on a route, or null when it presents none. */
export function presentedSecret(
  route: 'git' | 'gh',
  headers: ReadonlyArray<readonly [string, string]>,
): string | null {
  if (route === 'git') {
    const values = headers
      .filter(([name]) => name.toLowerCase() === SANDBOX_GITHUB_SESSION_HEADER.toLowerCase())
      .map(([, value]) => value.trim())
    return values.length === 1 ? (values[0] ?? null) : null
  }
  const values = headers
    .filter(([name]) => name.toLowerCase() === 'authorization')
    .map(([, value]) => value.trim())
  if (values.length !== 1) return null
  const match = /^(?:token|bearer)\s+(\S+)$/i.exec(values[0] ?? '')
  return match?.[1] ?? null
}

/**
 * Why a request is refused before its secret is even checked, or null.
 * Browsers attach `Origin` to cross-site and fetch requests and `Sec-Fetch-*`
 * to every request; neither gh nor git sends either. A unix socket is not
 * reachable from a web page, so this is defence in depth, not the boundary.
 */
export function browserRequestRefusal(
  headers: ReadonlyArray<readonly [string, string]>,
): string | null {
  for (const [name] of headers) {
    const lower = name.toLowerCase()
    if (lower === 'origin' || lower.startsWith('sec-fetch-')) {
      return 'browser requests are not accepted'
    }
  }
  return null
}
