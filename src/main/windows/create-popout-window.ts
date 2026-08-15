import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { RightPanelMode } from '@shared/types/state.ts'
import { getAppIcon } from '../app-icon.ts'
import { stashPopoutSeed } from '../services/popout-seed-store.ts'
import { attachWebContentsLockdown } from './web-contents-lockdown.ts'
import { registerTrustedAppFrame, unregisterTrustedAppFrame } from './app-frames.ts'
import { registerAppWindow } from './app-window-broadcast.ts'
import { bootThemeWindowOptions } from './boot-theme.ts'
import { attachRendererCrashRecovery } from './renderer-crash-recovery.ts'

/** Any right-panel pane can be detached into its own window. */
export type PopoutMode = RightPanelMode

const TITLES: Record<PopoutMode, string> = {
  explorer: 'Explorer — Copse',
  terminal: 'Terminal — Copse',
  changes: 'Changes — Copse',
  prs: 'Pull requests — Copse',
  memories: 'Memories — Copse',
  roadmap: 'Roadmap — Copse',
  browser: 'Browser — Copse',
}

/** Landscape default — pop-outs are auxiliary workspaces, not tall portrait strips. */
const POPOUT_WIDTH = 1024
const POPOUT_HEIGHT = 720
const POPOUT_MIN_WIDTH = 720
const POPOUT_MIN_HEIGHT = 480

// One shared pop-out window: re-invoking "Pop out" focuses it and switches mode
// rather than spawning duplicates or leaving portrait-sized strips.
let popoutWindow: BrowserWindow | null = null

function notifyPopoutMode(win: BrowserWindow, mode: PopoutMode): void {
  win.setTitle(TITLES[mode])
  if (win.webContents.isLoading()) return
  win.webContents.send('popout:switch-mode', mode)
}

/**
 * Open (or focus) a detached window that renders a single right-panel pane. The
 * window loads the same renderer as the main window with `?popout=<mode>`; the
 * renderer hides the projects sidebar, chat, and titlebar so only the pane
 * fills the window (see `styles/global/popout.css`).
 */
export function createPanePopoutWindow(mode: PopoutMode, seed?: unknown): BrowserWindow {
  stashPopoutSeed(mode, seed)

  const existing = popoutWindow
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    notifyPopoutMode(existing, mode)
    return existing
  }

  const icon = getAppIcon()
  const bootTheme = bootThemeWindowOptions()
  const win = new BrowserWindow({
    width: POPOUT_WIDTH,
    height: POPOUT_HEIGHT,
    minWidth: POPOUT_MIN_WIDTH,
    minHeight: POPOUT_MIN_HEIGHT,
    ...(icon ? { icon } : {}),
    title: TITLES[mode],
    backgroundColor: bootTheme.backgroundColor,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: true,
      preload: join(__dirname, '../preload/index.js'),
    },
  })
  popoutWindow = win
  attachWebContentsLockdown(win.webContents)
  attachRendererCrashRecovery(win.webContents)
  win.on('unresponsive', () => {
    console.warn('[renderer] pop-out window became unresponsive')
  })

  // Trust this window's main frame for IPC *before* the renderer boots so its
  // first API calls (settings/gh lookups) are not rejected by the frame guard.
  const frame = win.webContents.mainFrame
  registerTrustedAppFrame(frame)
  // Shared-state pushes (diff queue, file changes) fan out to every app window,
  // so the detached pane sees the same workspace the main window does (#1704).
  const unregisterBroadcast = registerAppWindow(win.webContents)

  win.once('ready-to-show', () => {
    win.show()
  })
  win.on('closed', () => {
    unregisterTrustedAppFrame(frame)
    unregisterBroadcast()
    popoutWindow = null
  })

  void win.loadFile(join(__dirname, '../renderer/index.html'), {
    query: { popout: mode, ...bootTheme.query },
  })
  return win
}
