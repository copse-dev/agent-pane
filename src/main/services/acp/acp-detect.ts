import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import {
  KNOWN_ACP_AGENTS,
  type DetectedAcpAgent,
  type KnownAcpAgent,
} from '@shared/acp-known-agents.ts'

const run = promisify(execFile)

export type { DetectedAcpAgent }

/**
 * Best-effort discovery of known ACP agents on this device: which are installed
 * (resolvable on PATH) and which are currently running. ACP agents are normally
 * spawned on demand over stdio rather than left running, so "running" is a weak
 * signal — surfaced for completeness, not relied on.
 *
 * Never throws: probing is wrapped so a missing `which`/`ps`, a denied process
 * listing, or an exotic platform degrades to "not found" rather than failing the
 * whole scan.
 */
export async function detectAcpAgents(
  agents: readonly KnownAcpAgent[] = KNOWN_ACP_AGENTS,
): Promise<DetectedAcpAgent[]> {
  const running = await listRunningCommands()
  const results = await Promise.all(
    agents.map(async (agent) => {
      const path = await resolveOnPath(agent.command)
      return {
        ...agent,
        installed: path !== null,
        path,
        running: running.has(agent.command),
      }
    }),
  )
  return results
}

/** Resolve a command to its absolute path via `which`/`where`, or null if absent. */
async function resolveOnPath(command: string): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await run(finder, [command], { timeout: 4000 })
    const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0)
    return first ? first.trim() : null
  } catch {
    return null
  }
}

/**
 * Basenames of argv[0] for currently-running processes. Used only to flag a
 * known agent as "running"; on platforms where listing fails we return an empty
 * set and every agent is reported as not running.
 */
async function listRunningCommands(): Promise<Set<string>> {
  if (process.platform === 'win32') return new Set() // tasklist parsing is brittle; skip.
  try {
    const { stdout } = await run('ps', ['-axww', '-o', 'args='], {
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    })
    const commands = new Set<string>()
    for (const line of stdout.split(/\r?\n/)) {
      const argv0 = line.trim().split(/\s+/)[0]
      if (argv0) commands.add(basename(argv0))
    }
    return commands
  } catch {
    return new Set()
  }
}
