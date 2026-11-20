import { homedir } from 'node:os'
import { runCommand } from '../../exec/command-runner.ts'
import { ghEnv, runGh } from '../gh-service.ts'

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
let cachedGitHubComToken: string | null = null

export function resetGitHubApiTokenCacheForTest(): void {
  cachedGhAuthToken = null
  cachedGitHubComToken = null
}

/**
 * Resolve a token for a live API call: prefer an env token, else fall back to
 * `gh auth token` (so a user with only `gh auth login` can still use the API
 * backend). Only a *successful* `gh auth token` is cached — a transient failure
 * (timeout, locked keychain) must not permanently lock the API backend out, so
 * failures are retried on the next call.
 *
 * The token belongs to the account, not to a project: `gh auth token` without
 * `--hostname` answers for the default host wherever it runs, and the API
 * backend calls GitHub from this process. So it runs in the user's home
 * directory rather than any project checkout, and never reads the window's
 * workspace (#3958).
 */
export async function resolveGitHubApiToken(): Promise<string | null> {
  const envToken = githubTokenFromEnv()
  if (envToken) return envToken
  if (cachedGhAuthToken) return cachedGhAuthToken
  try {
    const { stdout, code } = await runGh(['auth', 'token'], {
      timeout_ms: 10_000,
      cwd: homedir(),
    })
    if (code === 0 && stdout.trim()) cachedGhAuthToken = stdout.trim()
  } catch {
    // Leave the cache empty so the next call retries.
  }
  return cachedGhAuthToken
}

/** Env tokens gh uses for github.com itself; the enterprise ones authenticate `GH_HOST`. */
const GITHUB_COM_TOKEN_ENV_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const

/**
 * A token for github.com and api.github.com only, for a caller that always
 * sends it there: the container runs' GitHub read capability (A24). Unlike
 * {@link resolveGitHubApiToken} it never answers with a GitHub Enterprise
 * credential. `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` and the account
 * `GH_HOST` names belong to another server, so `gh auth token` is asked for
 * github.com by name, with no env token and no `GH_HOST`. With no github.com
 * sign-in the answer is null. Only a successful lookup is cached.
 */
export async function resolveGitHubComToken(): Promise<string | null> {
  for (const key of GITHUB_COM_TOKEN_ENV_KEYS) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  if (cachedGitHubComToken) return cachedGitHubComToken
  try {
    const { stdout, code } = await runCommand('gh', ['auth', 'token', '--hostname', 'github.com'], {
      cwd: homedir(),
      unsandboxed: true,
      timeout_ms: 10_000,
      // ghEnv blanks every token variable; blank GH_HOST too, so the merge
      // over this process's environment cannot point gh at another server.
      env: { ...ghEnv(process.env), GH_HOST: '' },
    })
    if (code === 0 && stdout.trim()) cachedGitHubComToken = stdout.trim()
  } catch {
    // Leave the cache empty so the next call retries.
  }
  return cachedGitHubComToken
}
