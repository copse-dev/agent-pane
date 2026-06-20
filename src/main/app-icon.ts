import { createHash } from 'node:crypto'
import { app, nativeImage } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Bundled next to main (dist/assets after build/dev copy). */
const assetsDir = join(__dirname, '../assets')
const iconPath = join(assetsDir, 'icon.png')
const dockPngPath = join(assetsDir, 'icons/icon-dock-512.png')

function icnsFingerprint(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)
}

export function getAppIconPath(): string {
  return iconPath
}

export function getAppIcon(): Electron.NativeImage | undefined {
  if (!existsSync(iconPath)) return undefined
  const image = nativeImage.createFromPath(iconPath)
  return image.isEmpty() ? undefined : image
}

export function applyAppIcon(): void {
  if (process.platform !== 'darwin') {
    const icon = getAppIcon()
    if (!icon) return
    app.dock?.setIcon(icon)
    return
  }

  if (app.isPackaged) {
    console.log('[app-icon] packaged — Dock uses bundle .icns (Icon Services squircle)')
    return
  }

  if (!existsSync(dockPngPath)) {
    console.warn('[app-icon] missing icon-dock-512.png — run: npm run icons:mac')
    return
  }

  const image = nativeImage.createFromPath(dockPngPath)
  if (image.isEmpty()) {
    console.warn('[app-icon] failed to load dock PNG:', dockPngPath)
    return
  }

  app.dock?.setIcon(image)
  const appIcns = join(assetsDir, 'icons/app.icns')
  const fp = existsSync(appIcns) ? icnsFingerprint(appIcns) : 'n/a'
  console.log(`[app-icon] dev dock setIcon from icon-dock-512.png (app.icns fp ${fp})`)
}
