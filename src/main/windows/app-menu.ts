import { app, Menu, dialog, type BrowserWindow } from 'electron'
import { registerAllowedWorkspaceRoot, setWorkspaceRoot } from '../services/workspace.ts'
import { startWorkspaceIndexing } from '../services/search/workspace-indexing.ts'
import { checkForUpdatesManually } from '../services/auto-update.ts'

// Builds the native application menu. The File ▸ Open Folder… item drives the
// same flow as the renderer's Open Folder button: pick a directory, set it as
// the workspace, kick off indexing, and notify the renderer to swap to the
// full layout via the 'workspace:opened' event.
export function buildAppMenu(win: BrowserWindow): void {
  const isMac = process.platform === 'darwin'

  async function openFolder(): Promise<void> {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return
    // Canonicalize (realpath) the selected folder before storing it as the
    // workspace root, mirroring the workspace:open/set IPC handlers. A
    // non-canonical (symlinked) root makes toRelativePath emit broken paths and
    // would leave the index and renderer 'workspace:opened' path inconsistent.
    const root = registerAllowedWorkspaceRoot(result.filePaths[0])
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
                  checkForUpdatesManually(win)
                },
              },
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: (): void => {
                  win.webContents.send('menu:settings')
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
      submenu: [
        {
          label: 'New Thread',
          accelerator: 'CmdOrCtrl+N',
          click: (): void => {
            win.webContents.send('menu:newThread')
          },
        },
        { type: 'separator' as const },
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => void openFolder(),
        },
        ...(isMac
          ? []
          : [
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: (): void => {
                  win.webContents.send('menu:settings')
                },
              },
            ]),
        { type: 'separator' as const },
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
      ],
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
            win.webContents.send('menu:togglePanel')
          },
        },
        {
          label: 'Explorer',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: (): void => {
            win.webContents.send('menu:showExplorer')
          },
        },
        {
          label: 'Terminal',
          accelerator: 'CmdOrCtrl+`',
          click: (): void => {
            win.webContents.send('menu:showTerminal')
          },
        },
        {
          label: 'Changes',
          accelerator: 'CmdOrCtrl+Shift+G',
          click: (): void => {
            win.webContents.send('menu:showChanges')
          },
        },
        {
          label: 'Browser',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: (): void => {
            win.webContents.send('menu:showBrowser')
          },
        },
        { type: 'separator' as const },
        { role: 'reload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
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
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
