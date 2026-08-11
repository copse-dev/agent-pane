/** Main → renderer request to create or reveal a visible browser-pane tab. */
export interface PluginBrowserTabRequest {
  requestId: number
  preferredTabId?: string
}

/** Renderer → main response once the tab's sandboxed webview is attached. */
export interface PluginBrowserTabReady {
  requestId: number
  ok: boolean
  tabId?: string
  webContentsId?: number
  error?: string
}
