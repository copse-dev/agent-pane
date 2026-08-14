import type { MenuItemConstructorOptions } from 'electron'

export interface AppFileMenuActions {
  createWindow(): void
  createThread(): void
  openFolder(): void
  openSettings(): void
}

export function buildAppFileMenuItems(
  actions: AppFileMenuActions,
  isMac: boolean,
): MenuItemConstructorOptions[] {
  return [
    {
      label: 'New Window',
      accelerator: 'CmdOrCtrl+Shift+N',
      click: (): void => {
        actions.createWindow()
      },
    },
    {
      label: 'New Thread',
      accelerator: 'CmdOrCtrl+N',
      click: (): void => {
        actions.createThread()
      },
    },
    { type: 'separator' },
    {
      label: 'Open Folder…',
      accelerator: 'CmdOrCtrl+O',
      click: (): void => {
        actions.openFolder()
      },
    },
    ...(isMac
      ? []
      : [
          { type: 'separator' as const },
          {
            label: 'Settings…',
            accelerator: 'CmdOrCtrl+,',
            click: (): void => {
              actions.openSettings()
            },
          },
        ]),
    { type: 'separator' },
    isMac ? { role: 'close' } : { role: 'quit' },
  ]
}
