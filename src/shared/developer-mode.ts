export const DEVELOPER_MODE_SETTING = 'developerMode'

// Compatibility with builds that exposed only the DevTools shortcut toggle.
// Read this as a fallback, but persist all new changes under developerMode.
export const LEGACY_DEVTOOLS_SHORTCUT_SETTING = 'devtoolsShortcutEnabled'

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
