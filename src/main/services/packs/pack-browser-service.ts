import type { PackBrowserTab, PackBrowserUploadFile } from './pack-tool-protocol.ts'

export interface PackBrowserOwner {
  readonly packId: string
  readonly threadId: string
  readonly allowedOrigins: readonly string[]
}

/** Electron-free surface consumed by the selected-pack worker host. */
export interface PackBrowserService {
  open(owner: PackBrowserOwner, url: string, newTab?: boolean): Promise<PackBrowserTab>
  navigate(owner: PackBrowserOwner, tabId: string, url: string): Promise<PackBrowserTab>
  tabs(owner: PackBrowserOwner): readonly PackBrowserTab[]
  snapshot(owner: PackBrowserOwner, tabId: string): Promise<string>
  click(owner: PackBrowserOwner, tabId: string, ref: string): Promise<void>
  type(owner: PackBrowserOwner, tabId: string, ref: string, text: string): Promise<void>
  upload(
    owner: PackBrowserOwner,
    tabId: string,
    ref: string,
    files: readonly PackBrowserUploadFile[],
  ): Promise<void>
  dispose(): void
}

let configuredService: PackBrowserService | null = null

export function setPackBrowserService(service: PackBrowserService | null): void {
  configuredService?.dispose()
  configuredService = service
}

export function getPackBrowserService(): PackBrowserService | null {
  return configuredService
}
