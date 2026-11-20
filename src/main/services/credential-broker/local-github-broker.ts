/**
 * The main-process GitHub broker for local executions (execution-runtime-security
 * R2). Issues a read-only grant to a contained command only, binds it to the
 * current turn's project, thread and principal, attaches the user's GitHub
 * login host-side and records every grant, use and refusal on that thread's
 * spine.
 */
import { mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getReadonlyToolBlockReason } from '@shared/tools/readonly-tools.ts'
import type { LocalGitHubBroker } from '../../project-sandbox/local-runtime.ts'
import { isAgentRunReadonly } from '../agent-run-readonly.ts'
import { runGh } from '../github/gh-service.ts'
import { recordDecision } from '../security/decision-log-store.ts'
import { resolveToolPermission } from '../security/tool-permissions.ts'
import { resolveExecutionPrincipal } from '../execution-runtime/principal.ts'
import { copseDataRoot } from '../storage/copse-paths.ts'
import { planToolBlockReason } from '../thread-plan-context.ts'
import {
  currentThreadExecutionContext,
  type ThreadExecutionContext,
} from '../thread-execution-context-store.ts'
import { isGhAvailable } from '../tool-availability.ts'
import {
  createGitHubCredentialBroker,
  fetchUpstream,
  GITHUB_BROKER_REQUEST_TIMEOUT_MS,
  type GitHubBrokerDependencies,
} from './github-broker.ts'

/** Runs `gh auth token` with these arguments; a non-zero code means no token. */
export type GhAuthTokenRunner = (args: string[]) => Promise<{ stdout: string; code: number }>

const runGhAuthToken: GhAuthTokenRunner = (args) =>
  runGh(args, { timeout_ms: 10_000, cwd: homedir() })

/**
 * The user's token for github.com, the only host the broker sends one to:
 * `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token` asked for github.com by
 * name. Never an Enterprise token: `GH_ENTERPRISE_TOKEN` and
 * `GITHUB_ENTERPRISE_TOKEN` belong to another host, and naming the host keeps
 * `GH_HOST` from choosing the Enterprise login. Only a successful lookup is
 * cached, so a locked keychain is retried on the next request.
 */
export function createGitHubDotComTokenResolver(
  env: NodeJS.ProcessEnv = process.env,
  runAuthToken: GhAuthTokenRunner = runGhAuthToken,
): () => Promise<string | null> {
  let cached: string | null = null
  return async () => {
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN'] as const) {
      const value = env[key]?.trim()
      if (value) return value
    }
    if (cached) return cached
    try {
      const { stdout, code } = await runAuthToken(['auth', 'token', '--hostname', 'github.com'])
      if (code === 0 && stdout.trim()) cached = stdout.trim()
    } catch {
      // Leave the cache empty so the next request retries.
    }
    return cached
  }
}

/**
 * Whether `gh_api_read` would run in this turn without a prompt: gh is
 * available (so the tool is registered), its per-tool policy is neither Ask
 * nor Block, and neither a draft plan nor a read-only run withholds it. A
 * contained command's read-only grant carries that same authority to every
 * process in the command, so it gets one only when the tool itself would.
 */
export function ghApiReadRunsUnprompted(): boolean {
  if (!isGhAvailable()) return false
  const policy = resolveToolPermission('gh_api_read')?.policy
  if (policy === 'ask' || policy === 'block') return false
  if (planToolBlockReason('gh_api_read') !== null) return false
  return !isAgentRunReadonly() || getReadonlyToolBlockReason('gh_api_read') === null
}

/**
 * Parent of every grant's directory: `<COPSE_DIR>/run`, which no sandbox
 * profile grants writes to. Not the system temp directory: on macOS that is
 * the per-user Darwin temp directory, whose direct children contained commands
 * may write, so another thread's command could rename a live grant's directory
 * and put its own gh config in its place. Canonical, so the read rule a
 * contained command gets for its grant matches the path Seatbelt sees, and
 * short, because a unix socket path is capped near 104 bytes on macOS.
 */
export function githubGrantStateDir(): string {
  const dir = join(copseDataRoot(), 'run')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return realpathSync(dir)
}

export interface LocalGitHubBrokerDependencies {
  readonly broker: GitHubBrokerDependencies
  readonly context: () => ThreadExecutionContext | null
  readonly readsRunUnprompted: () => boolean
}

/** What the desktop app runs the broker with. */
export const localGitHubBrokerDefaults = (): LocalGitHubBrokerDependencies => ({
  broker: {
    resolveToken: createGitHubDotComTokenResolver(),
    upstream: fetchUpstream,
    record: recordDecision,
    now: Date.now,
    stateDir: githubGrantStateDir,
    requestTimeoutMs: GITHUB_BROKER_REQUEST_TIMEOUT_MS,
  },
  context: currentThreadExecutionContext,
  readsRunUnprompted: ghApiReadRunsUnprompted,
})

export function createLocalGitHubBroker(
  dependencies: LocalGitHubBrokerDependencies = localGitHubBrokerDefaults(),
): LocalGitHubBroker {
  const broker = createGitHubCredentialBroker(dependencies.broker)
  return async ({ profile }) => {
    // A command outside the sandbox is not brokered: it keeps the account's
    // own gh login. Refused here too, not only in the spawn layer.
    if (profile.kind !== 'local' || profile.containment !== 'contained') return null
    const context = dependencies.context()
    if (!context) return null
    const principal = resolveExecutionPrincipal(context)
    // Unattended work never inherits the developer's login (binding decision 11).
    // No schedule names a credential reference yet, so an automation run gets
    // no grant; its commands still lose the raw tokens.
    if (principal.kind !== 'human') return null
    if (!dependencies.readsRunUnprompted()) return null
    try {
      return await broker.issue({
        principal,
        projectId: context.projectId,
        threadId: context.threadId,
        profile,
      })
    } catch (error) {
      // The child still loses its raw tokens; it just gets no grant.
      console.warn('[github-broker] could not issue a grant', error)
      return null
    }
  }
}
