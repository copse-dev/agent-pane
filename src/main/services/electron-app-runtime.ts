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
  const configured = runtime?.userDataPath ?? process.env['COPSE_PANEL_USER_DATA']?.trim()
  if (!configured) {
    throw new Error(
      'Copse userData path is unavailable outside Electron; install an ElectronAppRuntime or set COPSE_PANEL_USER_DATA.',
    )
  }
  return configured
}

export function getElectronAppVersion(): string {
  return runtime?.version ?? 'headless'
}

/** Source revision embedded by scripts/build.mts; null for unversioned test/headless runs. */
export function getElectronBuildCommit(): string | null {
  const commit =
    typeof __COPSE_BUILD_COMMIT__ === 'string' ? __COPSE_BUILD_COMMIT__.trim() : undefined
  return commit && commit !== 'unknown' ? commit : null
}

/** Whether working-tree changes were present when the bundle was built. */
export function getElectronBuildDirty(): boolean | null {
  return typeof __COPSE_BUILD_DIRTY__ === 'boolean' ? __COPSE_BUILD_DIRTY__ : null
}

export function isElectronAppPackaged(): boolean {
  return runtime?.isPackaged ?? false
}
