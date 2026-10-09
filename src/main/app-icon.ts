import { createHash } from 'node:crypto'
import { app, nativeImage, type BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AUTOMATION_APP_ICON_VARIANT,
  DEFAULT_APP_ICON_VARIANT,
  isAppIconVariant,
  type AppIconVariant,
} from '@shared/app-icon-variants.ts'
import { getSetting } from './services/storage/settings.ts'
import { getElectronAppVersion, getElectronBuildCommit } from './services/electron-app-runtime.ts'

/** Bundled next to main (dist/assets after build/dev copy). */
const assetsDir = join(__dirname, '../assets')
const automationMode = __COPSE_TEST_SCENARIOS__ && process.env['COPSE_E2E'] === '1'

function resolveVariantDir(variant: AppIconVariant): string {
  return join(assetsDir, 'icons', variant)
}

export function getAppIconVariant(): AppIconVariant {
  const stored = getSetting('appIconVariant', DEFAULT_APP_ICON_VARIANT)
  return isAppIconVariant(stored) ? stored : DEFAULT_APP_ICON_VARIANT
}

function effectiveAppIconVariant(): AppIconVariant {
  return automationMode ? AUTOMATION_APP_ICON_VARIANT : getAppIconVariant()
}

export function getAppIconPath(variant = effectiveAppIconVariant()): string {
  return join(resolveVariantDir(variant), 'icon-256.png')
}

function getDockIconPath(variant = effectiveAppIconVariant()): string {
  return join(resolveVariantDir(variant), 'icon-dock-512.png')
}

function icnsFingerprint(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)
}

export function getAppIcon(variant = effectiveAppIconVariant()): Electron.NativeImage | undefined {
  const iconPath = getAppIconPath(variant)
  if (!existsSync(iconPath)) return undefined
  const image = nativeImage.createFromPath(iconPath)
  return image.isEmpty() ? undefined : image
}

function loadDockIcon(variant = effectiveAppIconVariant()): Electron.NativeImage | undefined {
  const dockPngPath = getDockIconPath(variant)
  if (!existsSync(dockPngPath)) return undefined
  const image = nativeImage.createFromPath(dockPngPath)
  return image.isEmpty() ? undefined : image
}

/**
 * An unpackaged run (`electron dist/main/index.js`) has no Info.plist or
 * adjacent package.json of its own, so the stock About panel shows Electron's
 * icon and Electron's version. Spell out Copse's identity explicitly.
 */
function applyAboutPanel(variant: AppIconVariant): void {
  const commit = getElectronBuildCommit()
  app.setAboutPanelOptions({
    applicationName: app.name,
    applicationVersion: getElectronAppVersion(),
    version: commit ? commit.slice(0, 7) : '',
    iconPath: getAppIconPath(variant),
  })
}

export function applyAppIcon(windows: BrowserWindow[] = []): void {
  const variant = effectiveAppIconVariant()
  const windowIcon = getAppIcon(variant)
  applyAboutPanel(variant)

  for (const win of windows) {
    if (win.isDestroyed()) continue
    if (windowIcon) win.setIcon(windowIcon)
  }

  if (process.platform === 'darwin') {
    const dockIcon = loadDockIcon(variant)
    if (!dockIcon) {
      console.warn(`[app-icon] missing dock PNG for ${variant} — run: npm run generate:icon`)
      return
    }

    app.dock?.setIcon(dockIcon)
    const appIcns = join(resolveVariantDir(variant), 'app.icns')
    const fp = existsSync(appIcns) ? icnsFingerprint(appIcns) : 'n/a'
    const mode = app.isPackaged ? 'packaged' : 'dev'
    console.log(`[app-icon] ${mode} dock setIcon (${variant}, app.icns fp ${fp})`)
    return
  }

  if (windowIcon) {
    app.dock?.setIcon(windowIcon)
  }
}
