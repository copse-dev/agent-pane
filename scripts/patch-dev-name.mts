// Dev-only: macOS menu + Dock labels come from the running .app bundle (name +
// Info.plist), not app.setName(). Unpackaged `electron .` uses the Electron
// package dist (resolved via require, not a hardcoded node_modules path), so
// the Dock tooltip stays "Electron" even when CFBundleDisplayName is patched —
// Launch Services keys off the bundle path/filename. Spaces in the .app name
// break Chromium helper lookup (icudtl.dat / GPU process). Use Copse.app on
// disk; CFBundleDisplayName stays "Copse".
//
// Electron 42+ no longer downloads its macOS binary during the package's own
// install hook — the dist is fetched lazily on first `electron` CLI use. Root
// postinstall must therefore call install.js here before patching, or the first
// `pnpm start` launches stock Electron.app with a Dock label of "Electron".
//
// Across git worktrees, the extracted dist (~550MB with Copse.app) is shared
// under ~/.copse/cache/electron-dist/<ver>-<platform>-<arch>/; each worktree's
// electron/dist is a symlink into that cache. Copse.app is an APFS clone of
// Electron.app (cp -cR), not a full ditto copy.
//
// Runs on postinstall so it survives `pnpm install`. Does NOT rename
// CFBundleExecutable (the binary must stay "Electron").
import { createHash } from 'node:crypto'
import { execFileSync, execSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expectRecord, expectString, parseJsonUnknown } from '../src/shared/unknown-value.mts'
import { resolveDepRoot } from './resolve-dep.mts'

const APP_BUNDLE = 'Copse.app'
const DISPLAY_NAME = 'Copse'
const EXEC_REL = `${APP_BUNDLE}/Contents/MacOS/Electron`
/** Must stay in sync with electron/install.js getPlatformPath() for darwin. */
const ELECTRON_EXEC_REL = 'Electron.app/Contents/MacOS/Electron'

if (process.platform !== 'darwin') {
  process.exit(0)
}

const electronRoot = resolveDepRoot('electron')
const ELECTRON_PKG_JSON = join(electronRoot, 'package.json')
const ELECTRON_INSTALL_JS = join(electronRoot, 'install.js')
const PATH_TXT = join(electronRoot, 'path.txt')
const ELECTRON_DIST = join(electronRoot, 'dist')
const SOURCE_APP = join(ELECTRON_DIST, 'Electron.app')
const TARGET_APP = join(ELECTRON_DIST, APP_BUNDLE)
const sourcePlist = join(SOURCE_APP, 'Contents', 'Info.plist')

function readElectronPackageVersion(): string {
  const packageJson = expectRecord(
    parseJsonUnknown(readFileSync(ELECTRON_PKG_JSON, 'utf8')),
    'electron package.json',
  )
  return expectString(packageJson['version'], 'electron package version')
}

function readDistVersionAt(distDir: string): string | undefined {
  const versionFile = join(distDir, 'version')
  if (!existsSync(versionFile)) return undefined
  return readFileSync(versionFile, 'utf8').replace(/^v/, '').trim()
}

function readDistVersion(): string | undefined {
  return readDistVersionAt(ELECTRON_DIST)
}

function sharedElectronDistDir(pkgVersion: string): string {
  const override = process.env['COPSE_ELECTRON_DIST_CACHE']?.trim()
  const root = override ?? join(homedir(), '.copse', 'cache', 'electron-dist')
  return join(root, `${pkgVersion}-${process.platform}-${process.arch}`)
}

function sharedDistReady(sharedDist: string, pkgVersion: string): boolean {
  const plist = join(sharedDist, 'Electron.app', 'Contents', 'Info.plist')
  return existsSync(plist) && readDistVersionAt(sharedDist) === pkgVersion
}

/** Point electron/dist at the machine-wide cache (symlink). */
function linkDistToShared(sharedDist: string): void {
  mkdirSync(join(sharedDist, '..'), { recursive: true })

  if (!sharedDistReady(sharedDist, readElectronPackageVersion())) {
    if (!existsSync(ELECTRON_DIST) || lstatSync(ELECTRON_DIST).isSymbolicLink()) {
      throw new Error(
        `[patch-dev-name] shared Electron dist missing at ${sharedDist} and no local extract to promote`,
      )
    }
    if (existsSync(sharedDist)) {
      rmSync(sharedDist, { recursive: true, force: true })
    }
    renameSync(ELECTRON_DIST, sharedDist)
    console.log(`[patch-dev-name] promoted Electron dist → ${sharedDist}`)
  }

  if (existsSync(ELECTRON_DIST)) {
    const st = lstatSync(ELECTRON_DIST)
    if (st.isSymbolicLink()) {
      try {
        if (realpathSync(ELECTRON_DIST) === realpathSync(sharedDist)) return
      } catch {
        /* broken symlink — replace */
      }
      unlinkSync(ELECTRON_DIST)
    } else {
      rmSync(ELECTRON_DIST, { recursive: true, force: true })
    }
  }
  symlinkSync(sharedDist, ELECTRON_DIST, 'dir')
  console.log(`[patch-dev-name] electron/dist → ${sharedDist}`)
}

function ensureElectronDist(): void {
  if (!existsSync(ELECTRON_INSTALL_JS)) {
    console.log('[patch-dev-name] electron/install.js not found, skipping')
    process.exit(0)
  }

  const pkgVersion = readElectronPackageVersion()
  const sharedDist = sharedElectronDistDir(pkgVersion)

  if (sharedDistReady(sharedDist, pkgVersion)) {
    linkDistToShared(sharedDist)
    return
  }

  const distVersion = readDistVersion()
  const needsDownload =
    !existsSync(sourcePlist) || distVersion === undefined || distVersion !== pkgVersion

  if (needsDownload) {
    // install.js writes into electron/dist; if dist is a stale symlink, remove it first.
    if (existsSync(ELECTRON_DIST) && lstatSync(ELECTRON_DIST).isSymbolicLink()) {
      unlinkSync(ELECTRON_DIST)
    }
    console.log(
      `[patch-dev-name] fetching Electron ${pkgVersion} dist (Electron 42+ lazy download)`,
    )
    execFileSync(process.execPath, [ELECTRON_INSTALL_JS], { stdio: 'inherit' })
  }

  if (!existsSync(sourcePlist)) {
    console.log('[patch-dev-name] Electron.app not found after install.js, skipping')
    process.exit(0)
  }

  const pathTxt = existsSync(PATH_TXT) ? readFileSync(PATH_TXT, 'utf8').trim() : ''
  if (pathTxt !== ELECTRON_EXEC_REL && pathTxt !== EXEC_REL) {
    console.warn(
      `[patch-dev-name] expected path.txt → ${ELECTRON_EXEC_REL}, got ${pathTxt || '(missing)'}`,
    )
  }

  linkDistToShared(sharedDist)
}

function isPatchApplied(): boolean {
  if (!existsSync(PATH_TXT) || !existsSync(TARGET_APP)) return false
  if (readFileSync(PATH_TXT, 'utf8').trim() !== EXEC_REL) return false
  const distVersion = readDistVersion()
  return distVersion !== undefined && distVersion === readElectronPackageVersion()
}

/** Shared cache already has Copse.app — only need per-worktree path.txt. */
function adoptSharedCopseApp(): boolean {
  if (!existsSync(TARGET_APP)) return false
  const distVersion = readDistVersion()
  if (distVersion === undefined || distVersion !== readElectronPackageVersion()) return false
  writeFileSync(PATH_TXT, EXEC_REL)
  return true
}

/** APFS clone (copy-on-write) — avoids a second full ~275MB Electron.app copy. */
function cloneAppBundle(source: string, target: string): void {
  execFileSync('cp', ['-cR', source, target], { stdio: 'inherit' })
}

ensureElectronDist()

if (isPatchApplied() && process.env['COPSE_PANEL_REFRESH_DOCK'] !== '1') {
  console.log(
    `[patch-dev-name] ${APP_BUNDLE} already patched for Electron ${readDistVersion() ?? 'unknown'}`,
  )
  process.exit(0)
}

if (process.env['COPSE_PANEL_REFRESH_DOCK'] !== '1' && adoptSharedCopseApp() && isPatchApplied()) {
  console.log(
    `[patch-dev-name] ${APP_BUNDLE} reused from shared Electron dist (${readDistVersion() ?? 'unknown'})`,
  )
  process.exit(0)
}

for (const legacy of ['Agent Pane.app', 'AgentPane.app', APP_BUNDLE]) {
  rmSync(join(ELECTRON_DIST, legacy), { recursive: true, force: true })
}
cloneAppBundle(SOURCE_APP, TARGET_APP)

const targetPlist = join(TARGET_APP, 'Contents', 'Info.plist')
for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  try {
    execFileSync('plutil', ['-replace', key, '-string', DISPLAY_NAME, targetPlist])
  } catch (err) {
    console.warn(
      `[patch-dev-name] could not set ${key}:`,
      err instanceof Error ? err.message : String(err),
    )
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
  console.warn(
    '[patch-dev-name] could not set CFBundleIdentifier:',
    err instanceof Error ? err.message : String(err),
  )
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
    console.warn(
      '[patch-dev-name] could not set icon plist keys:',
      err instanceof Error ? err.message : String(err),
    )
  }
} else {
  console.warn(
    '[patch-dev-name] assets/icons/app.icns missing — run `pnpm run generate:icon` on macOS for a HIG-compliant Dock icon',
  )
}

try {
  execFileSync('codesign', ['--force', '--deep', '-s', '-', TARGET_APP])
} catch (err) {
  console.warn(
    '[patch-dev-name] codesign failed:',
    err instanceof Error ? err.message : String(err),
  )
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

if (process.env['COPSE_PANEL_REFRESH_DOCK'] === '1') {
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
    '[patch-dev-name] Cmd+Q Copse, then pnpm start. For Dock refresh: COPSE_PANEL_REFRESH_DOCK=1 pnpm run icons:mac',
  )
}
