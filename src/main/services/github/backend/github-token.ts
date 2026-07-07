import { runGh } from '../gh-service.ts'

/**
 * Bearer-token env vars the GitHub REST/GraphQL backend can authenticate with,
 * in priority order. Mirrors the set `gh` itself reads (see `gh-service.ts`).
 */
const GITHUB_TOKEN_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
] as const

/** The first non-empty GitHub token in the environment, or null. */
export function githubTokenFromEnv(base: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of GITHUB_TOKEN_ENV_KEYS) {
    const value = base[key]?.trim()
    if (value) return value
  }
  return null
}

/**
 * Whether the API backend has *some* way to authenticate, without paying for a
 * `gh auth token` subprocess. Used by the backend factory's `auto` decision, so
 * it only considers the (cheap, synchronous) env tokens. `gh auth token` is
 * still tried lazily at call time by {@link resolveGitHubApiToken}.
 */
export function hasGitHubApiToken(base: NodeJS.ProcessEnv = process.env): boolean {
  return githubTokenFromEnv(base) !== null
}

let cachedGhAuthToken: string | null | undefined

export function resetGitHubApiTokenCacheForTest(): void {
  cachedGhAuthToken = undefined
}

/**
 * Resolve a token for a live API call: prefer an env token, else fall back to
 * `gh auth token` (so a user with only `gh auth login` can still use the API
 * backend). The `gh auth token` result is cached for the process lifetime.
 */
export async function resolveGitHubApiToken(): Promise<string | null> {
  const envToken = githubTokenFromEnv()
  if (envToken) return envToken
  if (cachedGhAuthToken !== undefined) return cachedGhAuthToken
  try {
    const { stdout, code } = await runGh(['auth', 'token'], { timeout_ms: 10_000 })
    cachedGhAuthToken = code === 0 && stdout.trim() ? stdout.trim() : null
  } catch {
    cachedGhAuthToken = null
  }
  return cachedGhAuthToken
}
