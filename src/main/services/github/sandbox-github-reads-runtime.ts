/**
 * The app's one {@link SandboxGitHubReads}: started on the first contained
 * `run_shell` command after the experimental setting is turned on, stopped
 * when it is turned off and on quit. Any failure leaves the command exactly as
 * it ran before this feature existed.
 */
import {
  isProjectSandboxEnabled,
  type SandboxOnlySpawnAccess,
} from '../../project-sandbox/index.ts'
import { setSandboxGitHubReadRoute } from '../../project-sandbox/network-scope.ts'
import { getSetting } from '../storage/settings.ts'
import { resolveGitHubApiToken } from './backend/github-token.ts'
import { SandboxGitHubReads } from './sandbox-github-reads.ts'

/** Settings → Experimental → GitHub reads in the sandbox. Off by default. */
export const SANDBOX_GITHUB_READS_SETTING = 'sandboxGitHubReadsEnabled'

let running: Promise<SandboxGitHubReads> | null = null

/** Whether contained commands get GitHub reads now: the setting, and an active sandbox. */
export function sandboxGitHubReadsActive(): boolean {
  return getSetting<boolean>(SANDBOX_GITHUB_READS_SETTING, false) && isProjectSandboxEnabled()
}

async function start(): Promise<SandboxGitHubReads> {
  const reads = await SandboxGitHubReads.start({
    token: resolveGitHubApiToken,
    onLog: (entry) => {
      // Refusal reasons only: a request's path could carry anything.
      if (entry.event === 'refused') {
        console.warn(`[sandbox-github] ${entry.session}: refused, ${entry.detail ?? ''}`)
      }
    },
  })
  setSandboxGitHubReadRoute({ socketPath: reads.gitSocketPath })
  return reads
}

/**
 * The access a contained command in `threadId` is given, or null when the
 * feature is off, the sandbox is inactive, or the service could not start.
 */
export async function sandboxGitHubAccessForThread(
  threadId: string | null,
): Promise<SandboxOnlySpawnAccess | null> {
  if (!sandboxGitHubReadsActive()) {
    await stopSandboxGitHubReads()
    return null
  }
  if (threadId === null) return null
  try {
    running ??= start()
    const reads = await running
    return await reads.spawnFor(threadId)
  } catch (error) {
    console.warn('[sandbox-github] unavailable; commands run as before:', error)
    running = null
    setSandboxGitHubReadRoute(null)
    return null
  }
}

/** Remove the route and close every socket. Safe to call when never started. */
export async function stopSandboxGitHubReads(): Promise<void> {
  const current = running
  if (current === null) return
  running = null
  setSandboxGitHubReadRoute(null)
  const reads = await current.catch(() => null)
  await reads?.close()
}
