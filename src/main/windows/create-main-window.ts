import { BrowserWindow, globalShortcut, screen, type WebContents } from 'electron'
import { join } from 'node:path'
import { getAppIcon } from '../app-icon.ts'
import { getSetting, setSetting } from '../services/storage/settings.ts'
import { storageGet, storageSet } from '../services/storage/storage.ts'
import { attachWebContentsLockdown } from './web-contents-lockdown.ts'
import { bootThemeWindowOptions } from './boot-theme.ts'
import { getDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { DEVTOOLS_SHORTCUT_CAPABILITY } from '@copse/agent/plugins/devtools-shortcut-plugin.ts'
import { toggleDetachedDevTools } from '@shared/developer-mode.ts'
import type {
  MainWindowBounds,
  MainWindowNavigation,
  MainWindowRecord,
} from '@shared/types/main-window.ts'
import { MainWindowRegistry, type MainWindowContext } from './main-window-registry.ts'
import { MainWindowStateRepository } from './main-window-state.ts'
import { registerTrustedAppFrame, unregisterTrustedAppFrame } from './app-frames.ts'
import { registerAppWindow } from './app-window-broadcast.ts'
import { attachRendererCrashRecovery } from './renderer-crash-recovery.ts'

const mainWindowRegistry = new MainWindowRegistry<BrowserWindow>()
const mainWindowState = new MainWindowStateRepository({
  get: storageGet,
  set: storageSet,
})
let quitting = false

/** Temporary compatibility accessor for services that still target the primary window. */
export function getMainWindow(): BrowserWindow | null {
  return mainWindowRegistry.getPrimary()?.window ?? null
}

export function getFocusedMainWindow(): BrowserWindow | null {
  return (
    mainWindowRegistry.getFocused()?.window ??
    mainWindowRegistry.getMostRecentlyFocused()?.window ??
    getMainWindow()
  )
}

export function getMainWindowContext(
  webContents: Electron.WebContents,
): MainWindowContext<BrowserWindow> | undefined {
  return mainWindowRegistry.fromWebContents(webContents)
}

export function isPrimaryMainWindow(webContents: Electron.WebContents): boolean {
  return mainWindowRegistry.isPrimary(webContents)
}

export function assertPrimaryMainWindow(webContents: Electron.WebContents): void {
  if (!isPrimaryMainWindow(webContents)) {
    throw new Error('Agent actions are not available in secondary windows yet')
  }
}

function legacyNavigation(): MainWindowNavigation {
  const projectId = storageGet('activeProjectId')
  const threadId = storageGet('activeThreadId')
  return {
    activeProjectId: typeof projectId === 'string' ? projectId : null,
    activeThreadId: typeof threadId === 'string' ? threadId : null,
  }
}

function legacyBounds(): MainWindowBounds {
  return getSetting<MainWindowBounds>('windowBounds', { width: 1200, height: 800 })
}

export function getRestorableMainWindowRecords(): MainWindowRecord[] {
  return mainWindowState.loadOrMigrate({
    ...legacyNavigation(),
    bounds: legacyBounds(),
  })
}

export function beginMainWindowQuit(): void {
  quitting = true
}

function contextRecord(webContents: WebContents): MainWindowRecord | undefined {
  const context = mainWindowRegistry.fromWebContents(webContents)
  return context ? mainWindowState.get(context.id) : undefined
}

export function getMainWindowNavigation(webContents: WebContents): MainWindowNavigation {
  const record = contextRecord(webContents)
  return record
    ? {
        activeProjectId: record.activeProjectId,
        activeThreadId: record.activeThreadId,
      }
    : legacyNavigation()
}

export function setMainWindowNavigation(
  webContents: WebContents,
  navigation: MainWindowNavigation,
): void {
  const context = mainWindowRegistry.fromWebContents(webContents)
  if (!context) throw new Error('Window navigation rejected: sender is not a full main window')
  mainWindowState.update(context.id, navigation)
  // Keep the primary window mirrored into the legacy keys while singleton
  // services are migrated. Secondary windows must never overwrite this bridge.
  if (mainWindowRegistry.isPrimary(webContents)) {
    storageSet('activeProjectId', navigation.activeProjectId)
    storageSet('activeThreadId', navigation.activeThreadId)
  }
}

// A saved x/y can point at a display that's since been disconnected
// (e.g. an external monitor positioned left of the main screen → negative x).
// If the saved rect isn't substantially visible on a currently-connected
// display, drop the position so Electron centres the window instead.
export function sanitizeBounds(saved: MainWindowBounds, displayId?: string): MainWindowBounds {
  const { x: savedX, y: savedY } = saved
  if (savedX === undefined || savedY === undefined) return saved

  const displays = screen.getAllDisplays()
  const preferredDisplayExists =
    displayId === undefined || displays.some((display) => String(display.id) === displayId)
  const visible =
    preferredDisplayExists &&
    displays.some((display) => {
      const workArea = display.workArea
      // Require the window's top-left region to fall within a display's work area.
      const xOk = savedX >= workArea.x - 8 && savedX < workArea.x + workArea.width - 80
      const yOk = savedY >= workArea.y - 8 && savedY < workArea.y + workArea.height - 40
      return xOk && yOk
    })

  return visible ? saved : { width: saved.width, height: saved.height }
}

function createNewWindowRecord(): MainWindowRecord {
  const focused = mainWindowRegistry.getFocused() ?? mainWindowRegistry.getMostRecentlyFocused()
  const inherited = focused ? mainWindowState.get(focused.id) : undefined
  const sourceBounds = focused?.window.getNormalBounds() ?? legacyBounds()
  const cascaded: MainWindowBounds =
    sourceBounds.x === undefined || sourceBounds.y === undefined
      ? sourceBounds
      : { ...sourceBounds, x: sourceBounds.x + 28, y: sourceBounds.y + 28 }
  return mainWindowState.create({
    activeProjectId: inherited?.activeProjectId ?? legacyNavigation().activeProjectId,
    activeThreadId: inherited?.activeThreadId ?? legacyNavigation().activeThreadId,
    bounds: sanitizeBounds(cascaded),
  })
}

function captureWindowRecord(context: MainWindowContext<BrowserWindow>): void {
  const { window } = context
  if (window.isDestroyed()) return
  const maximized = window.isMaximized()
  const fullscreen = window.isFullScreen()
  const patch: Partial<Omit<MainWindowRecord, 'id'>> = {
    maximized,
    fullscreen,
  }
  if (!maximized && !fullscreen) {
    const bounds = window.getNormalBounds()
    patch.bounds = bounds
    patch.displayId = String(screen.getDisplayMatching(bounds).id)
  }
  mainWindowState.update(context.id, patch)
}

export function createMainWindow(restoredRecord?: MainWindowRecord): BrowserWindow {
  const record = restoredRecord ?? createNewWindowRecord()
  const saved = sanitizeBounds(record.bounds, record.displayId)
  const icon = getAppIcon()
  const bootTheme = bootThemeWindowOptions()
  const win = new BrowserWindow({
    ...saved,
    ...(icon ? { icon } : {}),
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    // y centers 12px traffic lights in the titlebar ((titlebar-height − 12) / 2).
    trafficLightPosition: { x: 12, y: 14 },
    backgroundColor: bootTheme.backgroundColor,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Run the renderer in a Chromium sandbox. The preload only uses
      // contextBridge/ipcRenderer (no Node APIs), so it stays functional while
      // a renderer compromise can no longer reach Node from the preload context.
      sandbox: true,
      spellcheck: false,
      webviewTag: true,
      preload: join(__dirname, '../preload/index.js'),
    },
  })
  const context = mainWindowRegistry.register(win, record.id)
  if (!mainWindowState.get(record.id)) {
    mainWindowState.create(
      {
        activeProjectId: record.activeProjectId,
        activeThreadId: record.activeThreadId,
        bounds: record.bounds,
      },
      record.id,
    )
    mainWindowState.update(record.id, record)
  }
  const frame = win.webContents.mainFrame
  registerTrustedAppFrame(frame)
  const unregisterBroadcast = registerAppWindow(win.webContents)

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleCapture = (): void => {
    if (persistTimer !== null) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      captureWindowRecord(context)
    }, 250)
  }
  win.on('focus', () => {
    mainWindowRegistry.markFocused(context.id)
    mainWindowState.update(context.id, { lastFocusedAt: Date.now() })
  })
  win.on('move', scheduleCapture)
  win.on('resize', scheduleCapture)
  win.on('maximize', scheduleCapture)
  win.on('unmaximize', scheduleCapture)
  win.on('enter-full-screen', scheduleCapture)
  win.on('leave-full-screen', scheduleCapture)
  win.on('close', () => {
    if (persistTimer !== null) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    captureWindowRecord(context)
    if (mainWindowRegistry.isPrimary(win.webContents)) {
      void setSetting('windowBounds', win.getNormalBounds())
    }
  })
  win.on('closed', () => {
    unregisterTrustedAppFrame(frame)
    unregisterBroadcast()
    mainWindowRegistry.unregister(context.id)
    if (!quitting) mainWindowState.remove(context.id)
  })

  attachWebContentsLockdown(win.webContents)
  attachRendererCrashRecovery(win.webContents)
  win.on('unresponsive', () => {
    console.warn('[renderer] main window became unresponsive')
  })
  win.once('ready-to-show', () => {
    if (record.maximized) win.maximize()
    if (record.fullscreen) win.setFullScreen(true)
    win.show()
  })
  // Fallback: if ready-to-show somehow never fires, force-show so the window
  // can never get stuck invisible.
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  }, 3000)
  void win.loadFile(join(__dirname, '../renderer/index.html'), { query: bootTheme.query })
  return win
}

const DEVTOOLS_SHORTCUT = 'Control+Shift+I'

/** Register the Ctrl+Shift+I DevTools shortcut (no-op if already registered). */
export function registerDevtoolsShortcut(): void {
  globalShortcut.register(DEVTOOLS_SHORTCUT, () => {
    const focused = getFocusedMainWindow()
    if (focused) toggleDetachedDevTools(focused.webContents)
  })
}

/** Unregister the Ctrl+Shift+I DevTools shortcut. */
export function unregisterDevtoolsShortcut(): void {
  globalShortcut.unregister(DEVTOOLS_SHORTCUT)
}

/**
 * Register or unregister the DevTools shortcut to match the current enablement
 * of the `copse.devtools-shortcut` first-party plugin's `devtools-shortcut`
 * capability. Called at boot (via `registerAllHandlers`) and again whenever the
 * plugin is toggled from Settings > Plugins (see `ipc/register-handlers.ts`
 * `plugins:setEnabled`), so the shortcut appears or disappears live — the atomic
 * plugin disable unregisters it in the same flag flip that drops the plugin's
 * capability from the Settings plugin list. Replaces the retired
 * `devtoolsShortcutEnabled` standalone setting: the plugin capability is now the
 * single source of truth.
 */
export function syncDevtoolsShortcut(): void {
  if (getDefaultPluginRegistry().isCapabilityActive(DEVTOOLS_SHORTCUT_CAPABILITY)) {
    registerDevtoolsShortcut()
  } else {
    unregisterDevtoolsShortcut()
  }
}
