// Dev-only: macOS menu + Dock labels come from the running .app bundle (name +
// Info.plist), not app.setName(). Unpackaged `electron .` uses
// node_modules/electron/dist/Electron.app, so the Dock tooltip stays "Electron"
// even when CFBundleDisplayName is patched — Launch Services keys off the bundle
// path/filename. Spaces in the .app name break Chromium helper lookup (icudtl.dat /
// GPU process). Use Copse.app on disk; CFBundleDisplayName stays "Copse".
//
// Electron 42+ no longer downloads its macOS binary during the package's own
// install hook — the dist is fetched lazily on first `electron` CLI use. Root
// postinstall must therefore call install.js here before patching, or the first
// `npm start` launches stock Electron.app with a Dock label of "Electron".
//
// Runs on postinstall so it survives `npm install`. Does NOT rename
// CFBundleExecutable (the binary must stay "Electron").
import { createHash } from 'node:crypto'
import { execFileSync, execSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const ELECTRON_DIST = join('node_modules', 'electron', 'dist')
const SOURCE_APP = join(ELECTRON_DIST, 'Electron.app')
const APP_BUNDLE = 'Copse.app'
const TARGET_APP = join(ELECTRON_DIST, APP_BUNDLE)
const DISPLAY_NAME = 'Copse'
const PATH_TXT = join('node_modules', 'electron', 'path.txt')
const EXEC_REL = `${APP_BUNDLE}/Contents/MacOS/Electron`
/** Must stay in sync with electron/install.js getPlatformPath() for darwin. */
const ELECTRON_EXEC_REL = 'Electron.app/Contents/MacOS/Electron'
const ELECTRON_INSTALL_JS = join('node_modules', 'electron', 'install.js')
const ELECTRON_VERSION_FILE = join(ELECTRON_DIST, 'version')
const ELECTRON_PKG_JSON = join('node_modules', 'electron', 'package.json')

if (process.platform !== 'darwin') {
  process.exit(0)
}

const sourcePlist = join(SOURCE_APP, 'Contents', 'Info.plist')

function readElectronPackageVersion(): string {
  return JSON.parse(readFileSync(ELECTRON_PKG_JSON, 'utf8')).version as string
}

function readDistVersion(): string | undefined {
  if (!existsSync(ELECTRON_VERSION_FILE)) return undefined
  return readFileSync(ELECTRON_VERSION_FILE, 'utf8').replace(/^v/, '').trim()
}

function ensureElectronDist(): void {
  if (!existsSync(ELECTRON_INSTALL_JS)) {
    console.log('[patch-dev-name] electron/install.js not found, skipping')
    process.exit(0)
  }

  const pkgVersion = readElectronPackageVersion()
  const distVersion = readDistVersion()
  const needsDownload =
    !existsSync(sourcePlist) || distVersion === undefined || distVersion !== pkgVersion

  if (!needsDownload) return

  console.log(`[patch-dev-name] fetching Electron ${pkgVersion} dist (Electron 42+ lazy download)`)
  execFileSync(process.execPath, [ELECTRON_INSTALL_JS], { stdio: 'inherit' })

  if (!existsSync(sourcePlist)) {
    console.log('[patch-dev-name] Electron.app not found after install.js, skipping')
    process.exit(0)
  }

  const pathTxt = existsSync(PATH_TXT) ? readFileSync(PATH_TXT, 'utf8').trim() : ''
  if (pathTxt !== ELECTRON_EXEC_REL) {
    console.warn(
      `[patch-dev-name] expected path.txt → ${ELECTRON_EXEC_REL}, got ${pathTxt || '(missing)'}`,
    )
  }
}

function isPatchApplied(): boolean {
  if (!existsSync(PATH_TXT) || !existsSync(TARGET_APP)) return false
  if (readFileSync(PATH_TXT, 'utf8').trim() !== EXEC_REL) return false
  const distVersion = readDistVersion()
  return distVersion !== undefined && distVersion === readElectronPackageVersion()
}

ensureElectronDist()

if (isPatchApplied() && process.env.COPSE_PANEL_REFRESH_DOCK !== '1') {
  console.log(`[patch-dev-name] ${APP_BUNDLE} already patched for Electron ${readDistVersion()}`)
  process.exit(0)
}

for (const legacy of ['Agent Pane.app', 'AgentPane.app', APP_BUNDLE]) {
  rmSync(join(ELECTRON_DIST, legacy), { recursive: true, force: true })
}
execSync(`ditto "${SOURCE_APP}" "${TARGET_APP}"`, { stdio: 'inherit' })

const targetPlist = join(TARGET_APP, 'Contents', 'Info.plist')
for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  try {
    execFileSync('plutil', ['-replace', key, '-string', DISPLAY_NAME, targetPlist])
  } catch (err) {
    console.warn(`[patch-dev-name] could not set ${key}:`, (err as Error).message)
  }
}
try {
  execFileSync('plutil', [
    '-replace',
    'CFBundleIdentifier',
    '-string',
    'dev.copse-panel',
    targetPlist,
  ])
} catch (err) {
  console.warn('[patch-dev-name] could not set CFBundleIdentifier:', (err as Error).message)
}

const ICNS = join('assets', 'icons', 'app.icns')
const resourcesDir = join(TARGET_APP, 'Contents', 'Resources')
let icnsHash: string | undefined
if (existsSync(ICNS)) {
  icnsHash = createHash('sha256').update(readFileSync(ICNS)).digest('hex').slice(0, 12)
  const iconBase = `copse-panel-${icnsHash}`
  for (const name of readdirSync(resourcesDir)) {
    if (name.startsWith('copse-panel') && name.endsWith('.icns')) {
      unlinkSync(join(resourcesDir, name))
    }
  }
  cpSync(ICNS, join(resourcesDir, `${iconBase}.icns`))
  const stockIcns = join(resourcesDir, 'electron.icns')
  if (existsSync(stockIcns)) unlinkSync(stockIcns)
  try {
    execFileSync('plutil', ['-replace', 'CFBundleIconFile', '-string', iconBase, targetPlist])
    execFileSync('plutil', ['-replace', 'CFBundleVersion', '-string', icnsHash, targetPlist])
    execFileSync('plutil', [
      '-replace',
      'CFBundleShortVersionString',
      '-string',
      `dev-${icnsHash}`,
      targetPlist,
    ])
  } catch (err) {
    console.warn('[patch-dev-name] could not set icon plist keys:', (err as Error).message)
  }
} else {
  console.warn(
    '[patch-dev-name] assets/icons/app.icns missing — run `npm run generate:icon` on macOS for a HIG-compliant Dock icon',
  )
}

try {
  execFileSync('codesign', ['--force', '--deep', '-s', '-', TARGET_APP])
} catch (err) {
  console.warn('[patch-dev-name] codesign failed:', (err as Error).message)
}

writeFileSync(PATH_TXT, EXEC_REL)

const lsregister =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
if (existsSync(lsregister)) {
  try {
    execFileSync(lsregister, ['-f', '-R', '-trusted', TARGET_APP])
  } catch {
    // Non-fatal; Dock picks up the new name after relaunch.
  }
}

console.log(
  `[patch-dev-name] using ${APP_BUNDLE} (path.txt → ${readFileSync(PATH_TXT, 'utf8').trim()})`,
)
if (icnsHash) {
  console.log(`[patch-dev-name] copse-panel.icns sha256:${icnsHash} (also CFBundleVersion)`)
}

if (process.env.COPSE_PANEL_REFRESH_DOCK === '1') {
  try {
    execSync('pkill -f "Copse.app/Contents/MacOS/Electron" || true', { stdio: 'ignore' })
  } catch {
    /* none running */
  }
  for (const proc of ['iconservicesd', 'Dock']) {
    try {
      execFileSync('killall', [proc])
    } catch {
      /* not running */
    }
  }
  console.log('[patch-dev-name] quit app if running; restarted Dock + IconServices cache')
} else {
  console.log(
    '[patch-dev-name] Cmd+Q Copse, then npm start. For Dock refresh: COPSE_PANEL_REFRESH_DOCK=1 npm run icons:mac',
  )
}
