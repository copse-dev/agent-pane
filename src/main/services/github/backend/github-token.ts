import { homedir } from 'node:os'
import { runGh } from '../gh-service.ts'

const GITHUB_DOT_COM = 'github.com'

/**
 * Bearer-token env vars gh reads for each kind of host, in its order of
 * precedence (`gh help environment`): `GH_TOKEN`, then `GITHUB_TOKEN` for
 * github.com and ghe.com; `GH_ENTERPRISE_TOKEN`, then `GITHUB_ENTERPRISE_TOKEN`
 * for a GitHub Enterprise Server host. `gh-service.ts` lists the same four.
 */
const DOT_COM_TOKEN_ENV_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const
const ENTERPRISE_TOKEN_ENV_KEYS = ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const

/**
 * Whether gh authenticates `host` with the github.com variables rather than
 * the Enterprise ones. That covers github.com and its subdomains, a ghe.com
 * subdomain, and gh's development host github.localhost; every other host is a
 * GitHub Enterprise Server. This mirrors gh's own token lookup (go-gh's
 * `tokenForHost`).
 */
function usesDotComTokens(host: string): boolean {
  const name = host.toLowerCase()
  return (
    name === GITHUB_DOT_COM ||
    name.endsWith(`.${GITHUB_DOT_COM}`) ||
    name === 'github.localhost' ||
    name.endsWith('.github.localhost') ||
    name.endsWith('.ghe.com')
  )
}

/** One DNS label: letters, digits and inner hyphens. */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * The host the API backend talks to: `GH_HOST` when set, else github.com. The
 * backend builds its URLs and chooses its token from this one value, so a
 * token is only sent to the host it was chosen for.
 *
 * `GH_HOST` is normalised first, so its spelling cannot make the token choice
 * and the destination disagree: lowercase, one trailing dot and a `:443` port
 * dropped, and github.com's subdomains (`api.github.com`) read as github.com,
 * as gh does. Null, so nothing is sent, when `GH_HOST` is not a bare
 * `host[:port]` (a URL with a scheme or path, say), or names github.com, a
 * ghe.com tenancy or github.localhost on a port other than 443.
 */
export function githubApiHost(base: NodeJS.ProcessEnv = process.env): string | null {
  const raw = base['GH_HOST']?.trim().toLowerCase()
  if (!raw) return GITHUB_DOT_COM
  const match = /^(.+?)\.?(?::(\d{1,5}))?$/.exec(raw)
  const name = match?.[1]
  if (!name?.split('.').every((label) => HOST_LABEL.test(label))) return null
  const portText = match?.[2]
  const port = portText === undefined ? 443 : Number(portText)
  if (port < 1 || port > 65_535) return null
  if (usesDotComTokens(name)) {
    if (port !== 443) return null
    return name.endsWith(`.${GITHUB_DOT_COM}`) ? GITHUB_DOT_COM : name
  }
  return port === 443 ? name : `${name}:${String(port)}`
}

/**
 * The env token gh would use for `host`, or null. A github.com token is never
 * returned for an Enterprise host, nor an Enterprise token for github.com.
 */
export function githubTokenFromEnv(
  host: string,
  base: NodeJS.ProcessEnv = process.env,
): string | null {
  const keys = usesDotComTokens(host) ? DOT_COM_TOKEN_ENV_KEYS : ENTERPRISE_TOKEN_ENV_KEYS
  for (const key of keys) {
    const value = base[key]?.trim()
    if (value) return value
  }
  return null
}

/**
 * Whether the API backend has *some* way to authenticate to its host, without
 * paying for a `gh auth token` subprocess. Used by the backend factory's `auto`
 * decision, so it only considers the (cheap, synchronous) env tokens.
 * `gh auth token` is still tried lazily at call time by
 * {@link resolveGitHubApiToken}.
 */
export function hasGitHubApiToken(base: NodeJS.ProcessEnv = process.env): boolean {
  const host = githubApiHost(base)
  return host !== null && githubTokenFromEnv(host, base) !== null
}

/**
 * What to tell a user whose API backend has no token for `host`: the variable
 * gh reads for that kind of host, or the `gh auth login` that stores one. A
 * github.com variable does nothing for an Enterprise host, so it is not named
 * there. Null `host` is a `GH_HOST` that {@link githubApiHost} refused.
 */
export function githubNoTokenMessage(host: string | null): string {
  if (host === null) {
    return 'GH_HOST is not a host name. Set it to one such as github.example.com, without https:// or a path.'
  }
  if (usesDotComTokens(host)) {
    return 'No GitHub token available. Set GH_TOKEN or GITHUB_TOKEN, or run `gh auth login`.'
  }
  return `No GitHub token available for ${host}. Set GH_ENTERPRISE_TOKEN, or run \`gh auth login --hostname ${host}\`.`
}

/** Successful `gh auth token` answers, by host. */
const cachedGhAuthTokens = new Map<string, string>()

export function resetGitHubApiTokenCacheForTest(): void {
  cachedGhAuthTokens.clear()
}

/**
 * Resolve a token for a live API call to `host` (by default the backend's own,
 * {@link githubApiHost}, and none when that refuses `GH_HOST`): the env token
 * gh would use for that host, else
 * `gh auth token --hostname <host>` (so a user with only `gh auth login` can
 * still use the API backend). Naming the host keeps `GH_HOST` from choosing
 * another host's login. Only a *successful* `gh auth token` is cached — a
 * transient failure (timeout, locked keychain) must not permanently lock the
 * API backend out, so failures are retried on the next call.
 *
 * The token belongs to the account, not to a project, and the API backend
 * calls GitHub from this process. So the lookup runs in the user's home
 * directory rather than any project checkout, and never reads the window's
 * workspace (#3958).
 */
export async function resolveGitHubApiToken(
  host: string | null = githubApiHost(),
): Promise<string | null> {
  if (host === null) return null
  const envToken = githubTokenFromEnv(host)
  if (envToken) return envToken
  const cached = cachedGhAuthTokens.get(host)
  if (cached) return cached
  try {
    const { stdout, code } = await runGh(['auth', 'token', '--hostname', host], {
      timeout_ms: 10_000,
      cwd: homedir(),
    })
    const token = stdout.trim()
    if (code === 0 && token) cachedGhAuthTokens.set(host, token)
  } catch {
    // Leave the cache empty so the next call retries.
  }
  return cachedGhAuthTokens.get(host) ?? null
}
