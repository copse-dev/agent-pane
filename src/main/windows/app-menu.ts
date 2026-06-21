import { app, Menu, dialog, type BrowserWindow } from 'electron'
import { setWorkspaceRoot } from '../services/workspace.ts'
import { buildIndex } from '../services/file-index.ts'

// Builds the native application menu. The File ▸ Open Folder… item drives the
// same flow as the renderer's Open Folder button: pick a directory, set it as
// the workspace, build the index, and notify the renderer to swap to the full
// layout via the 'workspace:opened' event.
export function buildAppMenu(win: BrowserWindow): void {
  const isMac = process.platform === 'darwin'

  async function openFolder(): Promise<void> {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return
    const root = result.filePaths[0]
    setWorkspaceRoot(root)
    await buildIndex(root)
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
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => win.webContents.send('menu:settings'),
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
                click: () => win.webContents.send('menu:settings'),
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
          click: () => win.webContents.send('menu:togglePanel'),
        },
        {
          label: 'Explorer',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => win.webContents.send('menu:showExplorer'),
        },
        {
          label: 'Terminal',
          accelerator: 'CmdOrCtrl+`',
          click: () => win.webContents.send('menu:showTerminal'),
        },
        {
          label: 'Changes',
          accelerator: 'CmdOrCtrl+Shift+G',
          click: () => win.webContents.send('menu:showChanges'),
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
