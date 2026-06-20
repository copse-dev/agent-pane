import { app, nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const iconPath = join(__dirname, '../assets/icon.png')

export function getAppIconPath(): string {
  return iconPath
}

export function getAppIcon(): Electron.NativeImage | undefined {
  if (!existsSync(iconPath)) return undefined
  const image = nativeImage.createFromPath(iconPath)
  return image.isEmpty() ? undefined : image
}

export function applyAppIcon(): void {
  const icon = getAppIcon()
  if (!icon || process.platform !== 'darwin') return
  app.dock?.setIcon(icon)
}
