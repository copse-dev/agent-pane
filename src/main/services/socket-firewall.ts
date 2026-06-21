import { spawn, spawnSync } from 'node:child_process'
import { getMainWindow } from '../windows/create-main-window.ts'

/**
 * Socket Firewall (`sfw`) integration. `sfw` wraps a package manager, proxies its
 * registry traffic, and blocks confirmed-malicious packages before they are
 * fetched — free and account-less. We require it for any agent-initiated package
 * install so installs never run unscanned. See `safe-install.ts` for the rewrite.
 */

const SFW_BIN = 'sfw'

let cachedAvailable: boolean | null = null

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

/** Install `sfw` globally (`npm install -g sfw`), streaming progress to the UI. */
export function installSocketFirewall(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const win = getMainWindow()
    const emit = (text: string) => win?.webContents.send('agent:shell_output', text)
    emit('[safe-install] installing Socket Firewall (npm install -g sfw)…\n')

    let proc
    try {
      proc = spawn('npm', ['install', '-g', SFW_BIN], {
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
