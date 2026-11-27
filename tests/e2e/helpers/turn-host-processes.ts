import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The resident turn host outlives the app by design (`turnsRunInHost`). The e2e
 * launcher stops the profile's host whenever it applies a new fixture
 * (`electron-shell/apply-seed-config.cjs`), so a spec's host never serves the
 * next spec's app.
 */

/** Pids of the hosts this profile started, from the host's own log. */
export function turnHostPids(userDataDir: string): number[] {
  const path = join(userDataDir, 'logs', 'turn-host.log')
  if (!existsSync(path)) return []
  return [...readFileSync(path, 'utf8').matchAll(/\(version .+, pid (\d+)\)/g)].map((match) =>
    Number(match[1]),
  )
}
