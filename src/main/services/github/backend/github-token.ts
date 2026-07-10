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

let cachedGhAuthToken: string | null = null

export function resetGitHubApiTokenCacheForTest(): void {
  cachedGhAuthToken = null
}

/**
 * Resolve a token for a live API call: prefer an env token, else fall back to
 * `gh auth token` (so a user with only `gh auth login` can still use the API
 * backend). Only a *successful* `gh auth token` is cached — a transient failure
 * (no workspace open yet, timeout, locked keychain) must not permanently lock
 * the API backend out, so failures are retried on the next call.
 */
export async function resolveGitHubApiToken(): Promise<string | null> {
  const envToken = githubTokenFromEnv()
  if (envToken) return envToken
  if (cachedGhAuthToken) return cachedGhAuthToken
  try {
    const { stdout, code } = await runGh(['auth', 'token'], { timeout_ms: 10_000 })
    if (code === 0 && stdout.trim()) cachedGhAuthToken = stdout.trim()
  } catch {
    // Leave the cache empty so the next call retries.
  }
  return cachedGhAuthToken
}
