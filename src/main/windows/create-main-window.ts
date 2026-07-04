import { BrowserWindow, globalShortcut, screen } from 'electron'
import { join } from 'node:path'
import { getAppIcon } from '../app-icon.ts'
import { getSetting, setSetting } from '../services/storage/settings.ts'
import { attachWebContentsLockdown } from './web-contents-lockdown.ts'

let mainWin: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWin
}

interface Bounds {
  width: number
  height: number
  x?: number
  y?: number
}

// A saved x/y can point at a display that's since been disconnected
// (e.g. an external monitor positioned left of the main screen → negative x).
// If the saved rect isn't substantially visible on a currently-connected
// display, drop the position so Electron centres the window instead.
function sanitizeBounds(saved: Bounds): Bounds {
  const { x: savedX, y: savedY } = saved
  if (savedX === undefined || savedY === undefined) return saved

  const displays = screen.getAllDisplays()
  const visible = displays.some((d) => {
    const wa = d.workArea
    // Require the window's top-left region to fall within a display's work area.
    const xOk = savedX >= wa.x - 8 && savedX < wa.x + wa.width - 80
    const yOk = savedY >= wa.y - 8 && savedY < wa.y + wa.height - 40
    return xOk && yOk
  })

  if (!visible) {
    return { width: saved.width, height: saved.height }
  }
  return saved
}

export function createMainWindow(): BrowserWindow {
  const saved = sanitizeBounds(getSetting<Bounds>('windowBounds', { width: 1200, height: 800 }))
  const icon = getAppIcon()
  const win = new BrowserWindow({
    ...saved,
    ...(icon ? { icon } : {}),
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    // y centers 12px traffic lights in the titlebar ((titlebar-height − 12) / 2).
    trafficLightPosition: { x: 12, y: 14 },
    backgroundColor: '#1e1e1e',
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
  mainWin = win
  attachWebContentsLockdown(win.webContents)
  win.once('ready-to-show', () => {
    win.show()
  })
  // Fallback: if ready-to-show somehow never fires, force-show so the window
  // can never get stuck invisible.
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  }, 3000)
  win.on('close', () => void setSetting('windowBounds', win.getBounds()))
  void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

const DEVTOOLS_SHORTCUT = 'Control+Shift+I'

/** Register the Ctrl+Shift+I DevTools shortcut (no-op if already registered). */
export function registerDevtoolsShortcut(win: BrowserWindow): void {
  globalShortcut.register(DEVTOOLS_SHORTCUT, () => {
    win.webContents.toggleDevTools()
  })
}

/** Unregister the Ctrl+Shift+I DevTools shortcut. */
export function unregisterDevtoolsShortcut(): void {
  globalShortcut.unregister(DEVTOOLS_SHORTCUT)
}
