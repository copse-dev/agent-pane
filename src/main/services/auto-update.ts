import { app, type BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { notifyUpdateDevOnly, requestUpdatePrompt } from './update-prompt.ts'

// Auto-update for the direct-download (Developer ID + notarized) macOS build.
//
// electron-builder embeds an `app-update.yml` pointing at this repo's GitHub
// Releases (see package.json `build.publish`) and publishes a `latest-mac.yml`
// feed next to each release zip. electron-updater reads that feed, downloads a
// newer *signed* build, and swaps it in on relaunch (Squirrel.Mac).
//
// Updates are never silent: a coding tool shouldn't replace its own binary
// mid-session without consent, so the user confirms the download, then again
// before the relaunch that installs it.

let wired = false

/**
 * Wire the background update check + prompts. No-op unless this is a packaged
 * macOS build — in dev/e2e/eval there is no update feed and electron-updater
 * would throw (`dev-app-update.yml not found`). Safe to call once per launch.
 */
export function initAutoUpdate(win: BrowserWindow): void {
  if (!app.isPackaged || process.platform !== 'darwin' || wired) return
  wired = true

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info: UpdateInfo): void => {
    void promptDownload(win, info.version)
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo): void => {
    void promptInstall(win, info.version)
  })
  autoUpdater.on('error', (err: Error): void => {
    console.warn('[auto-update] check failed:', err.message)
  })

  // Background check on launch; failures surface via the 'error' handler above.
  autoUpdater.checkForUpdates().catch(() => {
    /* reported via the 'error' handler */
  })
}

/**
 * Explicit "Check for Updates…" entry point (wired into the app menu). If an
 * update exists, the persistent `update-available` handler from initAutoUpdate
 * drives the prompt; on the packaged app a check just runs in the background.
 */
export function checkForUpdatesManually(win: BrowserWindow): void {
  if (!app.isPackaged || process.platform !== 'darwin') {
    notifyUpdateDevOnly(win)
    return
  }
  // initAutoUpdate ran at startup, so the result listeners are already attached.
  autoUpdater.checkForUpdates().catch(() => {
    /* reported via the 'error' handler registered in initAutoUpdate */
  })
}

async function promptDownload(_win: BrowserWindow, version: string): Promise<void> {
  const response = await requestUpdatePrompt({
    message: `Copse ${version} is available`,
    detail: 'Download the update now? You can install it immediately once downloaded.',
    buttons: ['Download', 'Later'],
    defaultIndex: 0,
    cancelIndex: 1,
  })
  if (response === 0) {
    autoUpdater.downloadUpdate().catch(() => {
      /* reported via the 'error' handler */
    })
  }
}

async function promptInstall(_win: BrowserWindow, version: string): Promise<void> {
  const response = await requestUpdatePrompt({
    message: `Copse ${version} is ready to install`,
    detail: 'Restart Copse to apply the update, or it will install the next time you quit.',
    buttons: ['Restart now', 'Later'],
    defaultIndex: 0,
    cancelIndex: 1,
  })
  if (response === 0) {
    // Defer so the dialog closes before Squirrel relaunches the app.
    setImmediate((): void => {
      autoUpdater.quitAndInstall()
    })
  }
}
