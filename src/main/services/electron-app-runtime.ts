import { copseUserDataDir } from './storage/copse-paths.ts'

/**
 * App metadata and paths supplied by the Electron entry point.
 *
 * Agent construction needs several services that also run in the desktop app,
 * but importing those services must not import Electron. The main entry point
 * installs this small value object during boot; headless consumers can install
 * their own values explicitly.
 */
export interface ElectronAppRuntime {
  userDataPath: string
  version: string
  isPackaged: boolean
}

let runtime: ElectronAppRuntime | null = null

export function setElectronAppRuntime(next: ElectronAppRuntime | null): void {
  runtime = next
}

export function getElectronUserDataPath(): string {
  const configured = runtime?.userDataPath ?? copseUserDataDir('')
  if (!configured) {
    throw new Error(
      'Copse userData path is unavailable outside Electron; install an ElectronAppRuntime or set COPSE_DIR (or COPSE_PANEL_USER_DATA).',
    )
  }
  return configured
}

export function getElectronAppVersion(): string {
  return runtime?.version ?? 'headless'
}

export function isElectronAppPackaged(): boolean {
  return runtime?.isPackaged ?? false
}
