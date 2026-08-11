import { BrowserWindow, ipcMain, webContents, type WebContents } from 'electron'
import { z } from 'zod'
import { errorMessage } from '@shared/errors.ts'
import type { PluginBrowserTab, PluginBrowserUploadFile } from './plugin-tool-protocol.ts'
import type { PluginBrowserTabRequest } from '@shared/types/plugin-browser.ts'
import { getInAppBrowserSession } from '../../windows/browser-web-contents.ts'
import {
  DOM_SNAPSHOT_SCRIPT,
  parsePageSnapshot,
  renderSnapshot,
} from '../browser/snapshot-format.ts'
import { expectBoolean } from '@shared/unknown-value.ts'
import type { PluginBrowserOwner, PluginBrowserService } from './plugin-browser-service.ts'

const TAB_READY_TIMEOUT_MS = 15_000
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

const zTabReady = z.strictObject({
  requestId: z.number().int().positive(),
  ok: z.boolean(),
  tabId: z.string().min(1).max(128).optional(),
  webContentsId: z.number().int().positive().optional(),
  error: z.string().max(8_192).optional(),
})

export interface PluginBrowserContents {
  isDestroyed(): boolean
  getURL(): string
  getTitle(): string
  loadURL(url: string): Promise<void>
  stop(): void
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  setAllowedOrigins(origins: readonly string[]): void
  consumeBlockedUrl(): string | null
}

export interface PluginBrowserPanelDependencies {
  ensureTab(preferredTabId?: string): Promise<{ tabId: string; webContentsId: number }>
  contentsFromId(id: number): PluginBrowserContents | null
  dispose?(): void
}

interface OwnedTabs {
  activeTabId: string | null
  readonly webContentsByTab: Map<string, number>
}

function ownerKey(owner: PluginBrowserOwner): string {
  return `${owner.pluginId}\u0000${owner.threadId}`
}

function allowedUrl(rawUrl: string, allowedOrigins: readonly string[]): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid browser URL: ${JSON.stringify(rawUrl)}.`)
  }
  if (!allowedOrigins.includes(url.origin)) {
    throw new Error(`Browser origin is not declared by this plugin: ${url.origin}.`)
  }
  return url
}

function canonicalUploadFiles(
  files: readonly PluginBrowserUploadFile[],
): PluginBrowserUploadFile[] {
  let bytes = 0
  return files.map((file) => {
    if (file.name.includes('/') || file.name.includes('\\') || file.name.includes('\u0000')) {
      throw new Error('Browser upload file names must not contain path separators.')
    }
    const decoded = Buffer.from(file.dataBase64, 'base64')
    if (decoded.length === 0 || decoded.toString('base64') !== file.dataBase64) {
      throw new Error(`Browser upload ${JSON.stringify(file.name)} is not canonical base64.`)
    }
    bytes += decoded.length
    if (bytes > MAX_UPLOAD_BYTES) {
      throw new Error('Browser uploads exceed the 8 MB operation limit.')
    }
    return { ...file }
  })
}

/**
 * Host-owned P4 bridge into the visible browser pane. The runtime supplies only
 * a plugin/thread identity and exact declared origins; tab ids and webContents are
 * resolved and checked here, never accepted as authority from the worker.
 */
export class PluginBrowserPanelService implements PluginBrowserService {
  private readonly owners = new Map<string, OwnedTabs>()
  private readonly dependencies: PluginBrowserPanelDependencies

  constructor(dependencies: PluginBrowserPanelDependencies) {
    this.dependencies = dependencies
  }

  private tabsFor(owner: PluginBrowserOwner): OwnedTabs {
    const key = ownerKey(owner)
    let tabs = this.owners.get(key)
    if (!tabs) {
      tabs = { activeTabId: null, webContentsByTab: new Map() }
      this.owners.set(key, tabs)
    }
    return tabs
  }

  private contents(owner: PluginBrowserOwner, tabId: string): PluginBrowserContents {
    const tabs = this.tabsFor(owner)
    const id = tabs.webContentsByTab.get(tabId)
    const contents = id === undefined ? null : this.dependencies.contentsFromId(id)
    if (!contents || contents.isDestroyed()) {
      tabs.webContentsByTab.delete(tabId)
      if (tabs.activeTabId === tabId) tabs.activeTabId = null
      throw new Error(`Unknown or closed plugin browser tab: ${tabId}.`)
    }
    contents.setAllowedOrigins(owner.allowedOrigins)
    const blockedUrl = contents.consumeBlockedUrl()
    if (blockedUrl) allowedUrl(blockedUrl, owner.allowedOrigins)
    const current = contents.getURL()
    if (current && current !== 'about:blank') allowedUrl(current, owner.allowedOrigins)
    tabs.activeTabId = tabId
    return contents
  }

  private tabInfo(
    tabId: string,
    contents: PluginBrowserContents,
    active: boolean,
  ): PluginBrowserTab {
    return {
      tabId,
      title: contents.getTitle(),
      url: contents.getURL(),
      active,
    }
  }

  private async load(
    owner: PluginBrowserOwner,
    tabId: string,
    contents: PluginBrowserContents,
    rawUrl: string,
  ): Promise<PluginBrowserTab> {
    const url = allowedUrl(rawUrl, owner.allowedOrigins)
    contents.consumeBlockedUrl()
    try {
      await contents.loadURL(url.href)
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      if (code !== 'ERR_ABORTED') {
        throw new Error(`Browser navigation failed: ${errorMessage(error)}`, { cause: error })
      }
    }
    const blockedUrl = contents.consumeBlockedUrl()
    if (blockedUrl) allowedUrl(blockedUrl, owner.allowedOrigins)
    const finalUrl = contents.getURL()
    try {
      allowedUrl(finalUrl, owner.allowedOrigins)
    } catch (error) {
      contents.stop()
      throw error
    }
    return this.tabInfo(tabId, contents, true)
  }

  async open(owner: PluginBrowserOwner, url: string, newTab = false): Promise<PluginBrowserTab> {
    allowedUrl(url, owner.allowedOrigins)
    const tabs = this.tabsFor(owner)
    const preferredTabId = newTab ? undefined : (tabs.activeTabId ?? undefined)
    const ready = await this.dependencies.ensureTab(preferredTabId)
    tabs.webContentsByTab.set(ready.tabId, ready.webContentsId)
    tabs.activeTabId = ready.tabId
    const contents = this.contents(owner, ready.tabId)
    return this.load(owner, ready.tabId, contents, url)
  }

  navigate(owner: PluginBrowserOwner, tabId: string, url: string): Promise<PluginBrowserTab> {
    const contents = this.contents(owner, tabId)
    return this.load(owner, tabId, contents, url)
  }

  tabs(owner: PluginBrowserOwner): readonly PluginBrowserTab[] {
    const tabs = this.tabsFor(owner)
    const out: PluginBrowserTab[] = []
    for (const tabId of [...tabs.webContentsByTab.keys()]) {
      try {
        const contents = this.contents(owner, tabId)
        out.push(this.tabInfo(tabId, contents, tabs.activeTabId === tabId))
      } catch {
        // A user may close a visible tab at any time; stale ownership is inert.
      }
    }
    return out
  }

  async snapshot(owner: PluginBrowserOwner, tabId: string): Promise<string> {
    const contents = this.contents(owner, tabId)
    const raw = await contents.executeJavaScript(DOM_SNAPSHOT_SCRIPT, true)
    return renderSnapshot(parsePageSnapshot(raw))
  }

  async click(owner: PluginBrowserOwner, tabId: string, ref: string): Promise<void> {
    const contents = this.contents(owner, tabId)
    const ok = expectBoolean(
      await contents.executeJavaScript(
        `(() => {
          const el = document.querySelector('[data-copse-ref=${JSON.stringify(ref)}]');
          if (!el) return false;
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        })()`,
        true,
      ),
    )
    if (!ok) throw new Error(`No browser element with ref ${ref}; take a new snapshot.`)
  }

  async type(owner: PluginBrowserOwner, tabId: string, ref: string, text: string): Promise<void> {
    const contents = this.contents(owner, tabId)
    const ok = expectBoolean(
      await contents.executeJavaScript(
        `(() => {
          const el = document.querySelector('[data-copse-ref=${JSON.stringify(ref)}]');
          if (!el) return false;
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(el.__proto__, 'value');
          if (setter?.set) setter.set.call(el, ${JSON.stringify(text)});
          else el.value = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`,
        true,
      ),
    )
    if (!ok) throw new Error(`No browser input with ref ${ref}; take a new snapshot.`)
  }

  async upload(
    owner: PluginBrowserOwner,
    tabId: string,
    ref: string,
    rawFiles: readonly PluginBrowserUploadFile[],
  ): Promise<void> {
    const contents = this.contents(owner, tabId)
    const files = canonicalUploadFiles(rawFiles)
    const ok = expectBoolean(
      await contents.executeJavaScript(
        `(() => {
          const input = document.querySelector('[data-copse-ref=${JSON.stringify(ref)}]');
          if (!(input instanceof HTMLInputElement) || input.type !== 'file') return false;
          const transfer = new DataTransfer();
          for (const file of ${JSON.stringify(files)}) {
            const binary = atob(file.dataBase64);
            const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
            transfer.items.add(new File([bytes], file.name, { type: file.mimeType }));
          }
          input.files = transfer.files;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`,
        true,
      ),
    )
    if (!ok) throw new Error(`No browser file input with ref ${ref}; take a new snapshot.`)
  }

  dispose(): void {
    this.dependencies.dispose?.()
    this.owners.clear()
  }
}

/** Main/renderer broker that asks the mounted browser pane for a visible tab. */
export function createPluginBrowserPanelService(win: BrowserWindow): PluginBrowserPanelService {
  let nextRequestId = 1
  const pending = new Map<
    number,
    {
      resolve: (value: { tabId: string; webContentsId: number }) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  const onReady = (event: Electron.IpcMainEvent, raw: unknown): void => {
    if (event.sender.id !== win.webContents.id) return
    const parsed = zTabReady.safeParse(raw)
    if (!parsed.success) return
    const ready = parsed.data
    const request = pending.get(ready.requestId)
    if (!request) return
    pending.delete(ready.requestId)
    clearTimeout(request.timer)
    if (!ready.ok || !ready.tabId || !ready.webContentsId) {
      request.reject(new Error(ready.error ?? 'The browser pane could not create a tab.'))
      return
    }
    request.resolve({ tabId: ready.tabId, webContentsId: ready.webContentsId })
  }
  ipcMain.on('plugins:browser-tab-ready', onReady)

  const guardCleanups: Array<() => void> = []
  const dispose = (): void => {
    ipcMain.off('plugins:browser-tab-ready', onReady)
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('The browser pane closed.'))
    }
    pending.clear()
    for (const cleanup of guardCleanups.splice(0)) cleanup()
  }
  win.once('closed', dispose)

  const guardedContents = new Map<number, PluginBrowserContents>()

  const browserContents = (contents: WebContents): PluginBrowserContents => {
    const existing = guardedContents.get(contents.id)
    if (existing) return existing
    let allowedOrigins: readonly string[] = []
    let blockedUrl: string | null = null
    const guardNavigation = (event: Electron.Event, targetUrl: string): void => {
      try {
        allowedUrl(targetUrl, allowedOrigins)
      } catch {
        blockedUrl = targetUrl
        event.preventDefault()
      }
    }
    const onDestroyed = (): void => {
      guardedContents.delete(contents.id)
    }
    contents.on('will-navigate', guardNavigation)
    contents.on('will-redirect', guardNavigation)
    contents.once('destroyed', onDestroyed)
    guardCleanups.push(() => {
      if (contents.isDestroyed()) return
      contents.off('will-navigate', guardNavigation)
      contents.off('will-redirect', guardNavigation)
      contents.off('destroyed', onDestroyed)
    })
    const guarded: PluginBrowserContents = {
      isDestroyed: () => contents.isDestroyed(),
      getURL: () => contents.getURL(),
      getTitle: () => contents.getTitle(),
      loadURL: (url) => contents.loadURL(url),
      stop: () => {
        contents.stop()
      },
      executeJavaScript: (code, userGesture) => contents.executeJavaScript(code, userGesture),
      setAllowedOrigins: (origins) => {
        allowedOrigins = origins
      },
      consumeBlockedUrl: () => {
        const blocked = blockedUrl
        blockedUrl = null
        return blocked
      },
    }
    guardedContents.set(contents.id, guarded)
    return guarded
  }

  return new PluginBrowserPanelService({
    ensureTab(preferredTabId): Promise<{ tabId: string; webContentsId: number }> {
      if (win.isDestroyed()) return Promise.reject(new Error('The browser pane is unavailable.'))
      const requestId = nextRequestId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          reject(new Error('Timed out waiting for the browser pane.'))
        }, TAB_READY_TIMEOUT_MS)
        timer.unref()
        pending.set(requestId, { resolve, reject, timer })
        const request: PluginBrowserTabRequest = {
          requestId,
          ...(preferredTabId ? { preferredTabId } : {}),
        }
        win.webContents.send('plugins:browser-tab-request', request)
      })
    },
    contentsFromId(id): PluginBrowserContents | null {
      const contents = webContents.fromId(id)
      if (!contents || contents.session !== getInAppBrowserSession()) return null
      return browserContents(contents)
    },
    dispose,
  })
}
