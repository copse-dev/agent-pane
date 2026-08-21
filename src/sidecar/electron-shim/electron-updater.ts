/**
 * Inert replacement for `electron-updater` in the Tauri sidecar bundle,
 * substituted by esbuild alias in scripts/build-tauri.mts.
 *
 * Auto-update only ever runs in the packaged macOS Electron build
 * (initAutoUpdate guards on that), but auto-update.ts imports the package at
 * module top, which would load real electron-updater code — and its own lazy
 * `require('electron')` paths — into the sidecar at boot. The Tauri app's
 * updater is the Tauri updater plugin (migration plan phase 3); electron code
 * must never load here (see the assertion in scripts/build-tauri.mts).
 */
import { EventEmitter } from 'node:events'

class AutoUpdaterStub extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  channel: string | null = null
  allowPrerelease = false
  allowDowngrade = false
  checkForUpdates(): Promise<null> {
    return Promise.reject(new Error('electron-updater is not available in the Tauri sidecar'))
  }
  downloadUpdate(): Promise<string[]> {
    return Promise.reject(new Error('electron-updater is not available in the Tauri sidecar'))
  }
  quitAndInstall(): void {}
}

export const autoUpdater = new AutoUpdaterStub()

export type UpdateInfo = Record<string, unknown>
