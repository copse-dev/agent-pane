import { app, Menu, dialog, type BrowserWindow } from 'electron'
import { registerAllowedWorkspaceRoot, setWorkspaceRoot } from '../services/workspace.ts'
import { startWorkspaceIndexing } from '../services/search/workspace-indexing.ts'
import { checkForUpdatesManually } from '../services/auto-update.ts'
import { toggleDetachedDevTools } from '@shared/developer-mode.ts'
import { buildAppFileMenuItems } from './app-menu-file-items.ts'

export interface AppMenuWindowProvider {
  getFocusedWindow(): BrowserWindow | null
  createWindow(): BrowserWindow
}

// Builds the native application menu. The File ▸ Open Folder… item drives the
// same flow as the renderer's Open Folder button: pick a directory, set it as
// the workspace, kick off indexing, and notify the renderer to swap to the
// full layout via the 'workspace:opened' event.
export function buildAppMenu(windows: AppMenuWindowProvider, developerMode = false): void {
  const isMac = process.platform === 'darwin'

  function sendToFocused(channel: string): void {
    windows.getFocusedWindow()?.webContents.send(channel)
  }

  async function openFolder(): Promise<void> {
    const win = windows.getFocusedWindow()
    if (!win) return
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return
    // Canonicalize (realpath) the selected folder before storing it as the
    // workspace root, mirroring the workspace:open/set IPC handlers. A
    // non-canonical (symlinked) root makes toRelativePath emit broken paths and
    // would leave the index and renderer 'workspace:opened' path inconsistent.
    const root = await registerAllowedWorkspaceRoot(result.filePaths[0])
    setWorkspaceRoot(root)
    // Same indexing flow as workspace:open/set — this path previously built
    // only the file index, silently skipping the semantic index and watcher.
    startWorkspaceIndexing(root)
    win.webContents.send('workspace:opened', root)
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Check for Updates…',
                click: (): void => {
                  const win = windows.getFocusedWindow()
                  if (win) checkForUpdatesManually(win)
                },
              },
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: (): void => {
                  sendToFocused('menu:settings')
                },
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: buildAppFileMenuItems(
        {
          createWindow: () => {
            windows.createWindow()
          },
          createThread: () => {
            sendToFocused('menu:newThread')
          },
          openFolder: () => {
            void openFolder()
          },
          openSettings: () => {
            sendToFocused('menu:settings')
          },
        },
        isMac,
      ),
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Panel',
          accelerator: 'CmdOrCtrl+B',
          click: (): void => {
            sendToFocused('menu:togglePanel')
          },
        },
        {
          label: 'Explorer',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: (): void => {
            sendToFocused('menu:showExplorer')
          },
        },
        {
          label: 'Terminal',
          accelerator: 'CmdOrCtrl+`',
          click: (): void => {
            sendToFocused('menu:showTerminal')
          },
        },
        {
          label: 'Changes',
          accelerator: 'CmdOrCtrl+Shift+G',
          click: (): void => {
            sendToFocused('menu:showChanges')
          },
        },
        {
          label: 'Browser',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: (): void => {
            sendToFocused('menu:showBrowser')
          },
        },
        // Cmd/Ctrl+L must reach us even while the browser's <webview> has focus.
        // A guest WebContents swallows its own key events, so a renderer keydown
        // listener never fires for the case that matters — typing in the page and
        // reaching for the address bar. The application menu sees the accelerator
        // first, whoever holds focus, which is why this is a menu item and not a
        // binding in keyboard-shortcuts.ts.
        {
          label: 'Focus Address Bar',
          accelerator: 'CmdOrCtrl+L',
          click: (): void => {
            sendToFocused('menu:focusBrowserUrlBar')
          },
        },
        { type: 'separator' as const },
        // Deliberately not the `reload` role: that binds Cmd+R to reloading the
        // whole renderer, which users hit expecting to refresh content (browser,
        // explorer) — each of which has its own reload — not blow away the entire
        // interface. Keep a menu escape hatch for reloading the shell, but with
        // no accelerator so Cmd+R no longer nukes the app.
        {
          label: 'Reload Interface',
          click: (): void => {
            windows.getFocusedWindow()?.webContents.reload()
          },
        },
        ...(developerMode
          ? [
              {
                label: 'Developer Tools',
                click: (): void => {
                  const win = windows.getFocusedWindow()
                  if (win) toggleDetachedDevTools(win.webContents)
                },
              },
            ]
          : []),
        { type: 'separator' as const },
        // Custom interface scale (CSS --ui-scale), not Chromium page zoom.
        // The built-in zoomIn/Out/resetZoom roles were unreliable in this
        // frameless shell; the renderer also binds the same accelerators.
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: (): void => {
            sendToFocused('menu:uiScaleReset')
          },
        },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: (): void => {
            sendToFocused('menu:uiScaleZoomIn')
          },
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: (): void => {
            sendToFocused('menu:uiScaleZoomOut')
          },
        },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac ? [{ role: 'front' as const }] : [{ role: 'close' as const }]),
      ],
    },
    {
      role: 'help' as const,
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          accelerator: 'CmdOrCtrl+/',
          click: (): void => {
            sendToFocused('menu:keyboardShortcuts')
          },
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
