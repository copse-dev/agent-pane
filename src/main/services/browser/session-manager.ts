import { errorMessage } from '@shared/errors.ts'
import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DOM_SNAPSHOT_SCRIPT, parsePageSnapshot, renderSnapshot } from './snapshot-format.ts'
import { expectBoolean } from '@shared/unknown-value.ts'
import { getElectronUserDataPath } from '../electron-app-runtime.ts'

const MAX_TABS = 8
// Wide enough to read a prototype's layout in the transcript, small enough
// that the data URL stays cheap to ship over IPC and hold in a message.
const PREVIEW_WIDTH = 480
const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 800

interface Tab {
  id: string
  window: BrowserWindow
}

export interface BrowserSessionPlatform {
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow
  getAgentSession(): Session
  showUrl(url: string): void
  /** Promote an already-rendered canvas artefact tab to the front, by title. */
  showArtefact(title: string): void
}

let platform: BrowserSessionPlatform | null = null

export function setBrowserSessionPlatform(next: BrowserSessionPlatform | null): void {
  platform = next
}

function requirePlatform(): BrowserSessionPlatform {
  if (!platform) throw new Error('Browser tools require the Electron browser-session platform.')
  return platform
}

export interface NavigateResult {
  viewId: string
  title: string
  url: string
}

export interface TabInfo {
  viewId: string
  title: string
  url: string
  active: boolean
}

/**
 * Manages hidden Electron BrowserWindows used by the built-in browser tools.
 * Pages render in their own Chromium sandbox, isolated from the Copse renderer.
 */
export class BrowserSessionManager {
  private tabs: Tab[] = []
  private lastActiveId: string | null = null
  private counter = 0

  private createTab(): Tab {
    if (this.tabs.length >= MAX_TABS) {
      throw new Error(`browser tab limit reached (${String(MAX_TABS)}); close a tab first`)
    }
    const id = `tab-${String(++this.counter)}`
    const browserPlatform = requirePlatform()
    const window = browserPlatform.createWindow({
      show: false,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      webPreferences: {
        // Dedicated agent browser profile, isolated from the user's interactive
        // browser pane, so automation never inherits the user's logged-in
        // cookies/storage and the user never browses under the agent (#467).
        // Still recognized by isBrowserWebContents, so guest lockdown — not the
        // renderer lockdown meant for app pages — applies to these tabs.
        session: browserPlatform.getAgentSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    const tab: Tab = { id, window }
    window.on('closed', () => {
      this.tabs = this.tabs.filter((t) => t.id !== id)
      if (this.lastActiveId === id) this.lastActiveId = this.tabs.at(-1)?.id ?? null
    })
    this.tabs.push(tab)
    this.lastActiveId = id
    return tab
  }

  private resolveTab(viewId?: string): Tab {
    if (viewId) {
      const found = this.tabs.find((t) => t.id === viewId)
      if (!found) throw new Error(`unknown browser tab: ${viewId}`)
      this.lastActiveId = found.id
      return found
    }
    if (this.lastActiveId) {
      const active = this.tabs.find((t) => t.id === this.lastActiveId)
      if (active) return active
    }
    return this.createTab()
  }

  async navigate(
    url: string,
    opts?: { newTab?: boolean | undefined; viewId?: string | undefined },
  ): Promise<NavigateResult> {
    const tab = opts?.newTab ? this.createTab() : this.resolveTab(opts?.viewId)
    this.lastActiveId = tab.id
    try {
      await tab.window.webContents.loadURL(url)
    } catch (err) {
      // Client-side redirects abort the original load; surface other failures.
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? (err as { code?: unknown }).code
          : undefined
      if (code !== 'ERR_ABORTED') {
        throw new Error(`navigation failed: ${errorMessage(err)}`, {
          cause: err,
        })
      }
    }
    const wc = tab.window.webContents
    return { viewId: tab.id, title: wc.getTitle(), url: wc.getURL() }
  }

  showUrl(url: string): void {
    requirePlatform().showUrl(url)
  }

  showArtefact(title: string): void {
    requirePlatform().showArtefact(title)
  }

  async snapshot(viewId?: string): Promise<string> {
    const tab = this.resolveTab(viewId)
    const raw: unknown = await tab.window.webContents.executeJavaScript(DOM_SNAPSHOT_SCRIPT, true)
    return renderSnapshot(parsePageSnapshot(raw))
  }

  async screenshot(viewId?: string): Promise<{ path: string; viewId: string }> {
    const tab = this.resolveTab(viewId)
    const image = await tab.window.webContents.capturePage()
    const dir = join(getElectronUserDataPath(), 'browser-screenshots')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${tab.id}-${String(Date.now())}.png`)
    await writeFile(path, image.toPNG())
    return { path, viewId: tab.id }
  }

  /**
   * A downscaled PNG `data:` URL of the tab, for the canvas preview card in the
   * transcript. Inline rather than a file path because the card renders in the
   * renderer, which cannot read arbitrary paths off disk, and because a preview
   * is disposable — nothing should outlive the message that showed it.
   *
   * Returns null instead of throwing: a missing thumbnail degrades the card,
   * it must never fail the render that produced the artefact.
   */
  async capturePreview(viewId: string, maxWidth = PREVIEW_WIDTH): Promise<string | null> {
    const tab = this.tabs.find((t) => t.id === viewId)
    if (!tab) return null
    try {
      const image = await tab.window.webContents.capturePage()
      if (image.isEmpty()) return null
      const { width } = image.getSize()
      const scaled = width > maxWidth ? image.resize({ width: maxWidth, quality: 'good' }) : image
      return scaled.toDataURL()
    } catch {
      return null
    }
  }

  async click(ref: string, viewId?: string): Promise<string> {
    const tab = this.resolveTab(viewId)
    const ok = expectBoolean(
      await tab.window.webContents.executeJavaScript(
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
    if (!ok) throw new Error(`no element with ref ${ref} (run browser_snapshot first)`)
    return `Clicked [ref=${ref}]`
  }

  async type(ref: string, text: string, viewId?: string): Promise<string> {
    const tab = this.resolveTab(viewId)
    const ok = expectBoolean(
      await tab.window.webContents.executeJavaScript(
        `(() => {
        const el = document.querySelector('[data-copse-ref=${JSON.stringify(ref)}]');
        if (!el) return false;
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(el.__proto__, 'value');
        if (setter && setter.set) setter.set.call(el, ${JSON.stringify(text)});
        else el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
        true,
      ),
    )
    if (!ok) throw new Error(`no element with ref ${ref} (run browser_snapshot first)`)
    return `Typed into [ref=${ref}]`
  }

  listTabs(): TabInfo[] {
    return this.tabs.map((t) => ({
      viewId: t.id,
      title: t.window.webContents.getTitle(),
      url: t.window.webContents.getURL(),
      active: t.id === this.lastActiveId,
    }))
  }

  closeTab(viewId: string): string {
    const tab = this.tabs.find((t) => t.id === viewId)
    if (!tab) throw new Error(`unknown browser tab: ${viewId}`)
    tab.window.destroy()
    return `Closed ${viewId}`
  }

  destroyAll(): void {
    for (const tab of this.tabs) {
      if (!tab.window.isDestroyed()) tab.window.destroy()
    }
    this.tabs = []
    this.lastActiveId = null
  }
}

let singleton: BrowserSessionManager | null = null

export function getBrowserSession(): BrowserSessionManager {
  singleton ??= new BrowserSessionManager()
  return singleton
}

export function shutdownBrowserSession(): void {
  singleton?.destroyAll()
  singleton = null
}
