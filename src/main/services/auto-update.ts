import { app, type BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { getUpdateCheckPlan, type AutoUpdatePolicy } from '../../shared/release-channel.mts'
import { chosenUpdateChannel } from '../../shared/update-channel-choice.ts'
import { getSetting, setSetting } from './storage/settings.ts'
import { RELEASES_URL, fetchUpdateChangelog } from './update-changelog.ts'
import { notifyUpdateDevOnly, requestUpdatePrompt } from './update-prompt.ts'

// Auto-update for the direct-download (Developer ID + notarized) macOS build.
//
// electron-builder embeds an `app-update.yml` pointing at the public,
// binary-only copse-dev/copse-releases repository (see package.json
// `build.publish`) and publishes channel-specific update metadata next to each
// release zip. Keeping the feed outside the source repository makes signed beta
// updates anonymously reachable while the source remains private.
//
// Updates are never silent: a coding tool shouldn't replace its own binary
// mid-session without consent, so the user confirms the download, then again
// before the relaunch that installs it.

let wired = false
// The policy of the check now running, so the prompt fetches matching notes.
let activePolicy: AutoUpdatePolicy | null = null

function applyPolicy(policy: AutoUpdatePolicy): void {
  // GitHub does not infer update channels from the version. Both channel and
  // allowPrerelease can enable downgrade inside electron-updater, so restore
  // the forward-fix-only invariant last.
  autoUpdater.channel = policy.channel
  autoUpdater.allowPrerelease = policy.allowPrerelease
  autoUpdater.allowDowngrade = policy.allowDowngrade
  activePolicy = policy
}

/** The checks for the channel chosen in Settings → About; see getUpdateCheckPlan. */
function updateCheckPlan(): AutoUpdatePolicy[] {
  const version = app.getVersion()
  const choice = chosenUpdateChannel(getSetting<string>('updateChannel', ''), version)
  if (choice.remember) {
    setSetting('updateChannel', choice.channel).catch((error: unknown) => {
      console.warn('[auto-update] could not remember the update channel:', error)
    })
  }
  return getUpdateCheckPlan(version, choice.channel)
}

/**
 * Run the plan's checks in order and stop at the first that finds an update.
 * A step that finds nothing, or fails because its channel has no release yet
 * (no stable release before 0.1.0), moves on; only the last step's failure is
 * reported. The `update-available` listener drives the prompt.
 */
async function runUpdateCheck(): Promise<void> {
  const plan = updateCheckPlan()
  for (const [index, policy] of plan.entries()) {
    applyPolicy(policy)
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result?.isUpdateAvailable === true) return
    } catch (error) {
      if (index === plan.length - 1) throw error
    }
  }
}

/**
 * Wire the background update check + prompts. No-op unless this is a packaged
 * macOS build — in dev/e2e/eval there is no update feed and electron-updater
 * would throw (`dev-app-update.yml not found`). Safe to call once per launch.
 */
export function initAutoUpdate(win: BrowserWindow): void {
  if (!app.isPackaged || process.platform !== 'darwin' || wired) return

  try {
    updateCheckPlan()
  } catch (error) {
    console.warn(
      '[auto-update] disabled for unsupported release version:',
      error instanceof Error ? error.message : error,
    )
    return
  }

  wired = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info: UpdateInfo): void => {
    void promptDownload(win, info.version, activePolicy?.allowPrerelease ?? false)
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo): void => {
    void promptInstall(win, info.version)
  })
  autoUpdater.on('error', (err: Error): void => {
    console.warn('[auto-update] check failed:', err.message)
  })

  // Background check on launch; failures surface via the 'error' handler above.
  runUpdateCheck().catch(() => {
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
  // The plan is read afresh, so a channel changed in Settings applies here.
  runUpdateCheck().catch(() => {
    /* reported via the 'error' handler registered in initAutoUpdate */
  })
}

async function promptDownload(
  _win: BrowserWindow,
  version: string,
  includePrereleases: boolean,
): Promise<void> {
  // Every version since the running one, so a user who skipped releases sees
  // what each changed. An unreachable API just leaves the changelog out.
  const changelog = await fetchUpdateChangelog({
    currentVersion: app.getVersion(),
    latestVersion: version,
    includePrereleases,
  })
  const response = await requestUpdatePrompt({
    message: `Copse ${version} is available`,
    detail: 'Download the update now? You can install it immediately once downloaded.',
    ...(changelog.length > 0 ? { changelog, changelogUrl: RELEASES_URL } : {}),
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
