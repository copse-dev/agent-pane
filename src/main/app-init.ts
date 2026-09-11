import {
  acquireVaultMaintenance,
  registerVaultProfileClient,
  retireVaultMaintenance,
} from '@copse/store-kit/profile-vault-access.ts'
import { existsSync } from 'node:fs'
import {
  recoverVaultMigration,
  readVaultManifest,
  assertVaultProfileState,
} from '@copse/store-kit/profile-vault-files.ts'
import { app } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { setElectronAppRuntime } from './services/electron-app-runtime.ts'
import { installElectronStoreBackend } from './services/storage/electron-store-backend.ts'
import { resolveUserDataDir } from './services/storage/user-data-migration.ts'

function augmentPathForGuiLaunch(): void {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const sep = process.platform === 'win32' ? ';' : ':'
  const current = process.env[pathKey] ?? ''
  const seen = new Set(current.split(sep).filter(Boolean))
  const extra = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.vera', 'bin'),
  ]
  if (process.platform !== 'win32') {
    extra.push('/usr/bin', '/bin')
  }
  const missing = extra.filter((entry) => !seen.has(entry))
  if (missing.length > 0) {
    process.env[pathKey] = [...missing, current].filter(Boolean).join(sep)
  }
}

augmentPathForGuiLaunch()

// MUST be imported before any module that constructs electron-store (storage.ts,
// settings.ts), because electron-store resolves its file path from
// app.getPath('userData') at construction time. ESM evaluates imports in source
// order, so keeping this as the first import in main/index.ts guarantees the
// name/path are set before those stores are built.
//
// Without this, an unpackaged `electron .` run stores data under an "Electron"
// directory and presents itself as "Electron" in the menu/About panel.
app.setName('Copse')

// Keep the whole profile under one root (`~/.copse`, or COPSE_DIR) so backing
// Copse up or moving it to another machine is one directory rather than a
// matched pair. Electron would default `userData` to `<appData>/copse-panel`;
// an existing profile there is migrated across on first launch, and a migration
// that cannot complete keeps using the legacy directory instead of booting into
// an empty one.
const userData = resolveUserDataDir(join(app.getPath('appData'), 'copse-panel'))
if (userData.outcome === 'moved' || userData.outcome === 'copied') {
  console.log(`[profile] Migrated Electron user data to ${userData.dir} (${userData.outcome})`)
} else if (userData.outcome === 'failed') {
  // `dir` is the legacy directory in this branch — data is intact, just not moved yet.
  console.error(
    `[profile] Could not migrate Electron user data; continuing with ${userData.dir}`,
    userData.error,
  )
} else if (userData.outcome === 'target-in-use') {
  console.warn(
    `[profile] Both the legacy and migrated Electron user-data directories hold data; using ${userData.dir}`,
  )
}
app.setPath('userData', userData.dir)

const sharedHeadlessProfile =
  process.argv.includes('--acp') ||
  process.argv.includes('--release-smoke-test') ||
  process.env['COPSE_AGENT_EVAL'] === '1'
// Acquire ownership before constructing any store or replaying a vault commit.
export const profileSingleInstanceLock = sharedHeadlessProfile || app.requestSingleInstanceLock()
if (!profileSingleInstanceLock) app.exit(0)
if (sharedHeadlessProfile) {
  const releaseClient = registerVaultProfileClient(userData.dir)
  process.once('exit', releaseClient)
  if (existsSync(join(userData.dir, '.vault-migration')) || readVaultManifest(userData.dir))
    throw new Error(
      'Device-encrypted profiles require the Copse desktop unlock service. Use a separate profile for headless work.',
    )
} else {
  retireVaultMaintenance(userData.dir)
  if (existsSync(join(userData.dir, '.vault-migration'))) {
    const releaseMaintenance = acquireVaultMaintenance(userData.dir)
    try {
      recoverVaultMigration(userData.dir)
    } finally {
      releaseMaintenance()
    }
  }
}
assertVaultProfileState(userData.dir)

setElectronAppRuntime({
  userDataPath: app.getPath('userData'),
  version: app.getVersion(),
  isPackaged: app.isPackaged,
})
installElectronStoreBackend()
