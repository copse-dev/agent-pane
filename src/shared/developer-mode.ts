export const DEVELOPER_MODE_SETTING = 'developerMode'

export interface DevToolsController {
  isDevToolsOpened(): boolean
  openDevTools(options: { mode: 'detach'; title: string }): void
  closeDevTools(): void
}

/** Toggle DevTools in a separate, non-dockable window. */
export function toggleDetachedDevTools(contents: DevToolsController): void {
  if (contents.isDevToolsOpened()) {
    contents.closeDevTools()
    return
  }
  contents.openDevTools({ mode: 'detach', title: 'Copse Developer Tools' })
}
