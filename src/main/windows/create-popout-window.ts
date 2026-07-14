import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { RightPanelMode } from '@shared/types/state.ts'
import { getAppIcon } from '../app-icon.ts'
import { attachWebContentsLockdown } from './web-contents-lockdown.ts'
import { registerTrustedAppFrame, unregisterTrustedAppFrame } from './app-frames.ts'
import { bootThemeWindowOptions } from './boot-theme.ts'

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

// One window per mode: re-invoking "Pop out" focuses the existing window rather
// than spawning duplicates.
const popoutWindows = new Map<PopoutMode, BrowserWindow>()

/**
 * Open (or focus) a detached window that renders a single right-panel pane. The
 * window loads the same renderer as the main window with `?popout=<mode>`; the
 * renderer hides the projects sidebar, chat, and titlebar so only the pane
 * fills the window (see `styles/global/popout.css`).
 */
export function createPanePopoutWindow(mode: PopoutMode): BrowserWindow {
  const existing = popoutWindows.get(mode)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return existing
  }

  const icon = getAppIcon()
  const bootTheme = bootThemeWindowOptions()
  const win = new BrowserWindow({
    width: 560,
    height: 780,
    minWidth: 360,
    minHeight: 420,
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
  popoutWindows.set(mode, win)
  attachWebContentsLockdown(win.webContents)

  // Trust this window's main frame for IPC *before* the renderer boots so its
  // first API calls (settings/gh lookups) are not rejected by the frame guard.
  const frame = win.webContents.mainFrame
  registerTrustedAppFrame(frame)

  win.once('ready-to-show', () => {
    win.show()
  })
  win.on('closed', () => {
    unregisterTrustedAppFrame(frame)
    popoutWindows.delete(mode)
  })

  void win.loadFile(join(__dirname, '../renderer/index.html'), {
    search: `popout=${mode}`,
    query: bootTheme.query,
  })
  return win
}
