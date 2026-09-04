import type { PluginBrowserTab, PluginBrowserUploadFile } from './plugin-tool-protocol.ts'

export interface PluginBrowserOwner {
  readonly pluginId: string
  readonly threadId: string
  readonly allowedOrigins: readonly string[]
}

/** Electron-free surface consumed by the selected-plugin worker host. */
export interface PluginBrowserService {
  open(owner: PluginBrowserOwner, url: string, newTab?: boolean): Promise<PluginBrowserTab>
  navigate(owner: PluginBrowserOwner, tabId: string, url: string): Promise<PluginBrowserTab>
  tabs(owner: PluginBrowserOwner): readonly PluginBrowserTab[]
  snapshot(owner: PluginBrowserOwner, tabId: string): Promise<string>
  click(owner: PluginBrowserOwner, tabId: string, ref: string): Promise<void>
  type(owner: PluginBrowserOwner, tabId: string, ref: string, text: string): Promise<void>
  upload(
    owner: PluginBrowserOwner,
    tabId: string,
    ref: string,
    files: readonly PluginBrowserUploadFile[],
  ): Promise<void>
  dispose(): void
}

let configuredService: PluginBrowserService | null = null

export function setPluginBrowserService(service: PluginBrowserService | null): void {
  configuredService?.dispose()
  configuredService = service
}

export function getPluginBrowserService(): PluginBrowserService | null {
  return configuredService
}
