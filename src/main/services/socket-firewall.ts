import { spawn, spawnSync } from 'node:child_process'
import { getMainWindow } from '../windows/create-main-window.ts'
import { getCurrentShellTaskId } from './shell-output-context.ts'

/**
 * Socket Firewall (`sfw`) integration. `sfw` wraps a package manager, proxies its
 * registry traffic, and blocks confirmed-malicious packages before they are
 * fetched — free and account-less. We require it for any agent-initiated package
 * install so installs never run unscanned. See `safe-install.ts` for the rewrite.
 */

const SFW_BIN = 'sfw'

/**
 * Pinned `sfw` version. This first install protects every later package install,
 * yet is itself unscanned, so it must be exact (no version range) and run with
 * lifecycle scripts disabled to defend against a typosquatted/compromised
 * publish of the short `sfw` name. Bump deliberately after reviewing the release.
 */
const SFW_VERSION = '2.0.6'

let cachedAvailable: boolean | null = null

/**
 * Build the npm argv used to install the pinned `sfw` globally. Exported (and
 * pure) so the security-critical install command can be unit-tested without
 * spawning a process. `--ignore-scripts` blocks npm lifecycle scripts; the
 * exact `sfw@<version>` spec prevents installing an unexpected version.
 */
export function sfwInstallArgs(): string[] {
  return ['install', '-g', '--ignore-scripts', `${SFW_BIN}@${SFW_VERSION}`]
}

/** Test/refresh hook — forget the cached availability probe. */
export function resetSocketFirewallCache(): void {
  cachedAvailable = null
}

/** Whether the `sfw` binary is on PATH. Result is cached after the first probe. */
export function isSocketFirewallAvailable(): boolean {
  if (cachedAvailable !== null) return cachedAvailable
  try {
    const probe = spawnSync(SFW_BIN, ['--version'], { stdio: 'ignore', timeout: 5000 })
    cachedAvailable = probe.status === 0
  } catch {
    cachedAvailable = false
  }
  return cachedAvailable
}

/**
 * Install the pinned `sfw` globally (`npm install -g --ignore-scripts
 * sfw@<version>`), streaming progress to the UI.
 */
export function installSocketFirewall(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const win = getMainWindow()
    const emit = (text: string) =>
      win?.webContents.send('agent:shell_output', text, getCurrentShellTaskId())
    const args = sfwInstallArgs()
    emit(`[safe-install] installing Socket Firewall (npm ${args.join(' ')})…\n`)

    let proc
    try {
      proc = spawn('npm', args, {
        stdio: 'pipe',
        signal,
        shell: process.platform === 'win32',
      })
    } catch {
      resolve(false)
      return
    }

    const stream = (data: Buffer) => emit(data.toString())
    proc.stdout?.on('data', stream)
    proc.stderr?.on('data', stream)
    proc.on('error', () => resolve(false))
    proc.on('close', (code) => {
      const ok = code === 0
      if (ok) cachedAvailable = true
      resolve(ok)
    })
  })
}
