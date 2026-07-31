import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { setElectronAppRuntime } from './services/electron-app-runtime.ts'
import { installElectronStoreBackend } from './services/storage/electron-store-backend.ts'
import { copseUserDataDir } from './services/storage/copse-paths.ts'

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
const userDataDir = copseUserDataDir(join(app.getPath('appData'), 'copse-panel'))
// Electron requires an app.setPath() target to exist. Creating it here makes a
// previously unused COPSE_DIR a genuinely one-variable fresh-profile launch.
mkdirSync(userDataDir, { recursive: true })
app.setPath('userData', userDataDir)

setElectronAppRuntime({
  userDataPath: app.getPath('userData'),
  version: app.getVersion(),
  isPackaged: app.isPackaged,
})
installElectronStoreBackend()
