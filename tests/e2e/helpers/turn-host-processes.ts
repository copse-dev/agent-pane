import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The resident turn host outlives the app by design (`turnsRunInHost`), so one
 * a spec's app started would serve the next spec's app with the profile, tools
 * and scripted scenarios it read before. Seeding a new profile stops it first;
 * the next app starts a fresh one.
 */

function hostLogPath(userDataDir: string): string {
  return join(userDataDir, 'logs', 'turn-host.log')
}

/** Pids of the hosts this profile started, from the host's own log. */
export function turnHostPids(userDataDir: string): number[] {
  const path = hostLogPath(userDataDir)
  if (!existsSync(path)) return []
  return [...readFileSync(path, 'utf8').matchAll(/\(version .+, pid (\d+)\)/g)].map((match) =>
    Number(match[1]),
  )
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Kill this profile's hosts and wait until each has exited. */
export function stopTurnHosts(userDataDir: string): void {
  const pids = turnHostPids(userDataDir).filter(alive)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  const tick = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + 5_000
  while (pids.some(alive) && Date.now() < deadline) Atomics.wait(tick, 0, 0, 20)

  // The next host logs its own pid; an old one must not be killed by number later.
  rmSync(hostLogPath(userDataDir), { force: true })
}
