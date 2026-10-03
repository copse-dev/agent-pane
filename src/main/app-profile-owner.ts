// Imported by the desktop entry (`index.ts`) directly after `app-init.ts`, and
// by nothing else: taking Electron's single-instance lock and replaying vault
// commits belong to the real app, not to every script that reuses app-init's
// name/userData setup (for example `scripts/classifier-eval-electron.mts`, a
// headless client that joins the profile through `joinSharedProfile`).
import { app, dialog } from 'electron'
import { setPersistentStoreFactory } from './services/storage/persistent-store.ts'
import { hasUnsafeVaultLaunchArguments } from './services/vault-launch-policy.ts'
import {
  joinSharedProfile,
  prepareOwnedProfile,
  profileStartupGuidance,
} from './services/storage/profile-ownership.ts'

const sharedHeadlessProfile =
  process.argv.includes('--acp') ||
  process.argv.includes('--release-smoke-test') ||
  process.env['COPSE_AGENT_EVAL'] === '1'

/**
 * A process that may not own the profile exits, and until it does every store
 * it constructs stays in memory: nothing writes the profile on its way out.
 */
function detachFromProfile(code: number): false {
  setPersistentStoreFactory(null)
  app.exit(code)
  return false
}

function refuseProfile(error: unknown, userData: string): false {
  const guidance = profileStartupGuidance(error, userData)
  console.error(`[profile] ${guidance}`)
  if (!sharedHeadlessProfile) dialog.showErrorBox('Copse cannot open this profile', guidance)
  return detachFromProfile(1)
}

/** True when this process may open the profile's stores. */
function claimProfile(): boolean {
  // Before any store opens or the vault can expose credentials: the packaged
  // app is a trusted vault caller, so debugger/V8 injection switches refuse it.
  if (
    app.isPackaged &&
    process.platform === 'darwin' &&
    hasUnsafeVaultLaunchArguments(process.argv)
  )
    return detachFromProfile(1)
  const userData = app.getPath('userData')
  if (sharedHeadlessProfile) {
    try {
      process.once('exit', joinSharedProfile(userData))
      return true
    } catch (error) {
      return refuseProfile(error, userData)
    }
  }
  // Acquire ownership before constructing any store or replaying a vault commit.
  // A second instance stops here: `app.exit` does not end synchronous module
  // evaluation, so nothing below may run without the lock.
  if (!app.requestSingleInstanceLock()) return detachFromProfile(0)
  try {
    prepareOwnedProfile(userData)
    return true
  } catch (error) {
    return refuseProfile(error, userData)
  }
}

export const profileSingleInstanceLock = claimProfile()
