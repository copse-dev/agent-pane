import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
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

/**
 * Resolve a command to its absolute path via `which`/`where`, or null if absent.
 * `env` is the environment the command will be spawned with, whose `PATH` is
 * the one a bare command resolves through (Copse's own by default).
 */
export async function resolveOnPath(
  command: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await run(finder, [command], { timeout: 4000, ...(env ? { env } : {}) })
    const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0)
    return first ? first.trim() : null
  } catch {
    return null
  }
}

/**
 * The file a POSIX shell would run for `command` with `path` as its PATH from
 * `cwd`, found by reading the filesystem only. Nothing on that PATH is
 * executed, so an entry the workspace controls (a planted `which`, say) cannot
 * run in Copse. As in a shell, an empty or relative entry resolves from `cwd`,
 * and a command containing a slash is a path from `cwd`, not searched for.
 * Null when no candidate is an executable regular file.
 */
export async function findExecutableOnPath(
  command: string,
  path: string,
  cwd: string,
): Promise<string | null> {
  const candidates = command.includes('/')
    ? [resolve(cwd, command)]
    : path.split(':').map((entry) => resolve(cwd, entry || '.', command))
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Absent, unreadable or not executable here: try the next entry.
    }
  }
  return null
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
