import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { createThread } from '@shared/store/thread-helpers.ts'
import { openBrowserUrl, openCanvasArtefact } from '../controller/panels.ts'
import { mountBrowserPane } from './browser-pane.ts'
import { createPendingApi } from '../fake-api.test-support.ts'
import { el, qsRequired } from '../dom/helpers.ts'
import { registerPromptAttachments } from '../attachments/prompt-attachments.ts'
import type { BrowserImageShare, BrowserTextShare } from '@shared/types/browser-share.ts'

interface FakeWebview extends HTMLElement {
  src: string
  getURL(): string
  canGoBack(): boolean
  canGoForward(): boolean
  reload(): void
  openDevTools?(): void
  getWebContentsId(): number
}

/** Stub the guest-webview methods jsdom lacks so `dom-ready` handlers can run. */
function stubWebviewMethods(webview: FakeWebview): void {
  webview.getURL = (): string => 'about:blank'
  webview.canGoBack = (): boolean => false
  webview.canGoForward = (): boolean => false
  webview.reload = (): void => {}
  webview.getWebContentsId = (): number => 42
}

function mountBrowserHosts(): { list: HTMLElement; viewer: HTMLElement } {
  const list = document.createElement('div')
  list.id = 'browser-tabs-host'
  const viewer = document.createElement('div')
  viewer.id = 'browser-viewer-host'
  document.body.append(list, viewer)
  return { list, viewer }
}

describe('browser pane requested URLs', () => {
  it('renders proposed workspace files for a localhost URL in the browser demo', async () => {
    const hadResizeObserver = Object.prototype.hasOwnProperty.call(globalThis, 'ResizeObserver')
    const ResizeObserverCtor = globalThis.ResizeObserver
    const hadDomParser = Object.prototype.hasOwnProperty.call(globalThis, 'DOMParser')
    const DomParserCtor = globalThis.DOMParser
    class NoopResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = NoopResizeObserver
    globalThis.DOMParser = window.DOMParser
    const { list, viewer } = mountBrowserHosts()
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      filesPaneOpen: true,
      rightPanelMode: 'browser',
    })
    const files = new Map([
      [
        'index.html',
        '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><h1>Cupcakes</h1><script src="script.js"></script></body></html>',
      ],
      ['styles.css', 'h1 { color: hotpink; }'],
      ['script.js', "document.body.dataset.ready = 'true'"],
    ])
    const reads: string[] = []
    const api = createPendingApi({
      'fs.readFile': async (_projectId: string, _threadId: string, path: string) => {
        reads.push(path)
        return files.get(path) ?? ''
      },
      'panes.popout': async (): Promise<void> => {},
    })
    const unmount = mountBrowserPane(list, viewer, store, api)

    try {
      openBrowserUrl(store, 'http://localhost:4173')
      await new Promise((resolve) => setTimeout(resolve, 20))

      const frame = qsRequired<HTMLIFrameElement>(viewer, 'iframe.browser-webview')
      assert.deepEqual(new Set(reads), new Set(['index.html', 'styles.css', 'script.js']))
      const srcdoc = frame.getAttribute('srcdoc') ?? ''
      assert.match(srcdoc, /<h1>Cupcakes<\/h1>/)
      assert.match(srcdoc, /<style data-workspace-path="styles.css">/)
      assert.match(srcdoc, /h1 \{ color: hotpink; \}/)
      assert.match(srcdoc, /<script data-workspace-path="script.js">/)
      assert.match(srcdoc, /document\.body\.dataset\.ready/)
      assert.equal(frame.src, 'http://localhost:4173/')
    } finally {
      if (hadResizeObserver) globalThis.ResizeObserver = ResizeObserverCtor
      else Reflect.deleteProperty(globalThis, 'ResizeObserver')
      if (hadDomParser) globalThis.DOMParser = DomParserCtor
      else Reflect.deleteProperty(globalThis, 'DOMParser')
      unmount()
    }
  })

  it('creates and reuses a visible tab for a selected-pack browser request', async () => {
    const hadResizeObserver = Object.prototype.hasOwnProperty.call(globalThis, 'ResizeObserver')
    const ResizeObserverCtor = globalThis.ResizeObserver
    class NoopResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = NoopResizeObserver
    const { list, viewer } = mountBrowserHosts()
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    let requestTab:
      | ((request: { requestId: number; preferredTabId?: string }) => Promise<{
          tabId: string
          webContentsId: number
        }>)
      | undefined
    const api = createPendingApi({
      'browser.onPackTabRequest': (handler: typeof requestTab): (() => void) => {
        requestTab = handler
        return (): void => {}
      },
      'panes.popout': async (): Promise<void> => {},
    })
    const unmount = mountBrowserPane(list, viewer, store, api)

    try {
      assert.ok(requestTab)
      const firstResult = requestTab({ requestId: 1 })
      const webview = qsRequired<FakeWebview>(viewer, '.browser-webview')
      stubWebviewMethods(webview)
      webview.dispatchEvent(new Event('dom-ready'))
      const first = await firstResult

      assert.equal(first.webContentsId, 42)
      assert.equal(store.getState().filesPaneOpen, true)
      assert.equal(store.getState().rightPanelMode, 'browser')
      assert.equal(list.querySelectorAll('.browser-tabs-tab').length, 1)

      const second = await requestTab({ requestId: 2, preferredTabId: first.tabId })
      assert.deepEqual(second, first)
      assert.equal(list.querySelectorAll('.browser-tabs-tab').length, 1)
    } finally {
      if (hadResizeObserver) globalThis.ResizeObserver = ResizeObserverCtor
      else Reflect.deleteProperty(globalThis, 'ResizeObserver')
      unmount()
    }
  })

  it('opens Cursor agent run URLs in a browser tab without switching threads', () => {
    const raf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      cb(0)
      return 0
    }
    const hadResizeObserver = Object.prototype.hasOwnProperty.call(globalThis, 'ResizeObserver')
    const ResizeObserverCtor = globalThis.ResizeObserver
    class NoopResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = NoopResizeObserver

    const { list, viewer } = mountBrowserHosts()
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'browser' })
    const linkedThreadId = createThread(store)
    const activeThreadId = createThread(store)
    store.setState({
      threads: store.getState().threads.map((thread) =>
        thread.id === linkedThreadId
          ? {
              ...thread,
              remoteAgentLink: {
                provider: 'cursor',
                agentId: 'bc-linked-agent',
                createdAt: Date.now(),
              },
            }
          : thread,
      ),
      activeThreadId,
    })
    const callbacks: { openTab?: (url: string) => void } = {}
    const api = createPendingApi({
      'browser.onOpenTab': (handler: (url: string) => void): (() => void) => {
        callbacks.openTab = handler
        return (): void => {}
      },
      'panes.popout': async (): Promise<void> => {},
    })
    const unmount = mountBrowserPane(list, viewer, store, api)

    try {
      const popupHandler = callbacks.openTab
      assert.ok(popupHandler)
      popupHandler('https://cursor.com/agents/bc-linked-agent?from=github')

      // Thread handoff is PR-pane only; browser navigation stays on the agents page.
      assert.equal(store.getState().activeThreadId, activeThreadId)
      assert.equal(list.querySelectorAll('.browser-tabs-tab').length, 2)

      const agentTab = [...list.querySelectorAll('.browser-tabs-tab')].find((tab) =>
        tab.textContent.includes('cursor.com'),
      )
      assert.ok(agentTab)
    } finally {
      globalThis.requestAnimationFrame = raf
      if (hadResizeObserver) globalThis.ResizeObserver = ResizeObserverCtor
      else Reflect.deleteProperty(globalThis, 'ResizeObserver')
      unmount()
    }
  })

  it('loads a requested Cursor agents URL in the active browser tab', () => {
    const raf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      cb(0)
      return 0
    }
    const hadResizeObserver = Object.prototype.hasOwnProperty.call(globalThis, 'ResizeObserver')
    const ResizeObserverCtor = globalThis.ResizeObserver
    class NoopResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = NoopResizeObserver

    const { list, viewer } = mountBrowserHosts()
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'browser' })
    const linkedThreadId = createThread(store)
    const activeThreadId = createThread(store)
    store.setState({
      threads: store.getState().threads.map((thread) =>
        thread.id === linkedThreadId
          ? {
              ...thread,
              remoteAgentLink: {
                provider: 'cursor',
                agentId: 'bc-requested-agent',
                createdAt: Date.now(),
              },
            }
          : thread,
      ),
      activeThreadId,
    })
    const unmount = mountBrowserPane(list, viewer, store)

    try {
      const webview = qsRequired<FakeWebview>(viewer, '.browser-webview')
      stubWebviewMethods(webview)
      webview.dispatchEvent(new Event('dom-ready'))

      openBrowserUrl(store, 'https://cursor.com/agents/bc-requested-agent')

      assert.equal(store.getState().activeThreadId, activeThreadId)
      assert.match(webview.src, /cursor\.com\/agents\/bc-requested-agent/)
      assert.equal(list.querySelectorAll('.browser-tabs-tab').length, 1)

      const urlInput = viewer.querySelector<HTMLInputElement>('.browser-url-input')
      assert.ok(urlInput)
      assert.match(urlInput.value, /cursor\.com\/agents\/bc-requested-agent/)
    } finally {
      globalThis.requestAnimationFrame = raf
      if (hadResizeObserver) globalThis.ResizeObserver = ResizeObserverCtor
      else Reflect.deleteProperty(globalThis, 'ResizeObserver')
      unmount()
    }
  })

  it('opens a requested URL in the active tab address bar', () => {
    const raf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      cb(0)
      return 0
    }
    const ResizeObserverCtor: typeof ResizeObserver | undefined = globalThis.ResizeObserver
    class NoopResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = NoopResizeObserver

    const { list, viewer } = mountBrowserHosts()
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    const unmount = mountBrowserPane(list, viewer, store)

    try {
      openBrowserUrl(store, 'https://example.com/docs')

      const urlInput = viewer.querySelector<HTMLInputElement>('.browser-url-input')
      assert.ok(urlInput)
      assert.match(urlInput.value, /example\.com\/docs/)

      const tabLabel = list.querySelector('.browser-tabs-tab-label')?.textContent
      assert.match(tabLabel ?? '', /example\.com/)
    } finally {
      globalThis.requestAnimationFrame = raf
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the global may be undefined in the test DOM, so restore only when it existed
      if (ResizeObserverCtor) globalThis.ResizeObserver = ResizeObserverCtor
      else delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
      unmount()
    }
  })

  it('focuses and selects the address bar on a url-bar focus request', () => {
    const raf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      cb(0)
      return 0
    }
    const ResizeObserverCtor: typeof ResizeObserver | undefined = globalThis.ResizeObserver
    class NoopResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = NoopResizeObserver

    const { list, viewer } = mountBrowserHosts()
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'browser' })
    const unmount = mountBrowserPane(list, viewer, store)

    try {
      openBrowserUrl(store, 'https://example.com/docs')
      const urlInput = qsRequired<HTMLInputElement>(viewer, '.browser-url-input')
      // Park focus somewhere else first: the regression this guards against was a
      // handler that only worked when the address bar was already focused.
      const elsewhere = el('input', { type: 'text' })
      document.body.append(elsewhere)
      elsewhere.focus()
      assert.notEqual(document.activeElement, urlInput)

      store.emit('browser_url_bar_focus_requested')

      assert.equal(document.activeElement, urlInput)
      assert.equal(urlInput.selectionStart, 0)
      assert.equal(urlInput.selectionEnd, urlInput.value.length)
      assert.ok(urlInput.value.length > 0)
      elsewhere.remove()
    } finally {
      globalThis.requestAnimationFrame = raf
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the global may be undefined in the test DOM, so restore only when it existed
      if (ResizeObserverCtor) globalThis.ResizeObserver = ResizeObserverCtor
      else delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
      unmount()
    }
  })

  it('renders an HTML artefact in a sandboxed tab via a data: URL', () => {
    const raf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      cb(0)
      return 0
    }
    const ResizeObserverCtor: typeof ResizeObserver | undefined = globalThis.ResizeObserver
    class NoopResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = NoopResizeObserver

    const { list, viewer } = mountBrowserHosts()
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    const unmount = mountBrowserPane(list, viewer, store)

    try {
      openCanvasArtefact(store, {
        title: 'Sales Dashboard',
        mimeType: 'text/html',
        body: '<!doctype html><h1>Sales</h1>',
      })

      // The artefact opens in a new, active tab (a blank tab is created first).
      const activePanel = viewer.querySelector('.browser-tab-panel.is-active')
      assert.ok(activePanel, 'artefact tab should be active')
      const webview = activePanel.querySelector<FakeWebview>('.browser-webview')
      assert.ok(webview, 'artefact tab should create a webview')
      stubWebviewMethods(webview)
      webview.dispatchEvent(new Event('dom-ready'))

      // Loaded as an opaque data: URL (sandboxed, no origin/network grant).
      assert.match(webview.src, /^data:text\/html/)
      const decoded = Buffer.from(webview.src.split('base64,')[1] ?? '', 'base64').toString('utf8')
      assert.match(decoded, /<h1>Sales<\/h1>/)

      // Friendly title on the tab; the (large) data URL is hidden from the bar.
      const activeLabel = list.querySelector('.browser-tabs-tab.is-active .browser-tabs-tab-label')
      assert.equal(activeLabel?.textContent, 'Sales Dashboard')
      const urlInput = qsRequired<HTMLInputElement>(activePanel, '.browser-url-input')
      assert.equal(urlInput.value, '')

      // Opening an artefact switches the right panel to the browser canvas.
      assert.equal(store.getState().rightPanelMode, 'browser')
    } finally {
      globalThis.requestAnimationFrame = raf
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the global may be undefined in the test DOM, so restore only when it existed
      if (ResizeObserverCtor) globalThis.ResizeObserver = ResizeObserverCtor
      else delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
      unmount()
    }
  })

  it('shares page context and offers external-browser tools from the toolbar menu', () => {
    const raf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      cb(0)
      return 0
    }
    const ResizeObserverCtor: typeof ResizeObserver | undefined = globalThis.ResizeObserver
    class NoopResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = NoopResizeObserver

    const { list, viewer } = mountBrowserHosts()
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'browser' })
    const opened: string[] = []
    const sharedPageIds: number[] = []
    const sharedScreenshotIds: number[] = []
    const attachedText: BrowserTextShare[] = []
    const attachedImages: BrowserImageShare[] = []
    let shareTextHandler: ((share: BrowserTextShare) => void) | undefined
    let shareImageHandler: ((share: BrowserImageShare) => void) | undefined
    let composerFocused = false
    let devToolsOpens = 0
    // Minimal ApiClient surface the browser pane touches (popout, tab forwarding,
    // and the new shell.openExternal for "open in default browser").
    const api = createPendingApi({
      'browser.onOpenTab': (): (() => void) => (): void => {},
      'browser.sharePageText': async (id: number): Promise<void> => void sharedPageIds.push(id),
      'browser.shareScreenshot': async (id: number): Promise<void> =>
        void sharedScreenshotIds.push(id),
      'browser.onShareText': (handler: (share: BrowserTextShare) => void): (() => void) => {
        shareTextHandler = handler
        return (): void => {}
      },
      'browser.onShareImage': (handler: (share: BrowserImageShare) => void): (() => void) => {
        shareImageHandler = handler
        return (): void => {}
      },
      'panes.popout': async (): Promise<void> => {},
      'shell.openExternal': async (url: string): Promise<void> => void opened.push(url),
    })
    const unregisterAttachments = registerPromptAttachments({
      attachFile: () => {},
      attachTextBlock: (content, label) => {
        attachedText.push({ content, label: label ?? '' })
      },
      attachImage: (dataUrl, mimeType) => {
        assert.equal(mimeType, 'image/png')
        attachedImages.push({ dataUrl, mimeType: 'image/png' })
      },
      attachVideo: () => Promise.resolve(),
      attachArchive: () => Promise.resolve(),
      focusComposer: () => {
        composerFocused = true
      },
    })
    const unmount = mountBrowserPane(list, viewer, store, api)

    try {
      const panel = viewer.querySelector('.browser-tab-panel.is-active')
      assert.ok(panel)
      const menuBtn = panel.querySelector<HTMLButtonElement>('.browser-menu-btn')
      const menu = panel.querySelector<HTMLElement>('.browser-menu')
      assert.ok(menuBtn && menu, 'toolbar exposes an overflow menu')
      assert.ok(menu.hasAttribute('hidden'), 'menu starts collapsed')

      // Give the guest a real page so "open in default browser" is actionable.
      const webview = qsRequired<FakeWebview>(panel, '.browser-webview')
      webview.getURL = (): string => 'https://example.com/page'
      webview.canGoBack = (): boolean => false
      webview.canGoForward = (): boolean => false
      webview.reload = (): void => {}
      webview.openDevTools = (): void => void (devToolsOpens += 1)
      webview.getWebContentsId = (): number => 42
      webview.dispatchEvent(new Event('dom-ready'))

      menuBtn.click()
      assert.ok(!menu.hasAttribute('hidden'), 'clicking the button opens the menu')

      const items = menu.querySelectorAll<HTMLButtonElement>('.browser-menu-item')
      const shareTextItem = items[0]
      const shareScreenshotItem = items[1]
      const openExternalItem = items[2]
      const inspectorItem = items[3]
      assert.ok(shareTextItem && shareScreenshotItem && openExternalItem && inspectorItem)
      assert.equal(shareTextItem.textContent, 'Share page text')
      assert.equal(shareScreenshotItem.textContent, 'Share screenshot')
      assert.equal(shareTextItem.disabled, false)
      assert.equal(shareScreenshotItem.disabled, false)
      assert.equal(openExternalItem.disabled, false, 'a real page enables open-in-default-browser')

      shareTextItem.click()
      assert.deepEqual(sharedPageIds, [42])
      assert.ok(menu.hasAttribute('hidden'), 'sharing page text closes the menu')

      menuBtn.click()
      shareScreenshotItem.click()
      assert.deepEqual(sharedScreenshotIds, [42])

      assert.ok(shareTextHandler && shareImageHandler)
      shareTextHandler({
        content: 'Source: https://example.com\n\nSelected page copy',
        label: 'Browser page — Example',
      })
      shareImageHandler({ dataUrl: 'data:image/png;base64,QUJD', mimeType: 'image/png' })
      assert.deepEqual(attachedText, [
        {
          content: 'Source: https://example.com\n\nSelected page copy',
          label: 'Browser page — Example',
        },
      ])
      assert.deepEqual(attachedImages, [
        { dataUrl: 'data:image/png;base64,QUJD', mimeType: 'image/png' },
      ])
      assert.equal(composerFocused, true)

      menuBtn.click()
      openExternalItem.click()
      assert.deepEqual(opened, ['https://example.com/page'])
      assert.ok(menu.hasAttribute('hidden'), 'selecting an item closes the menu')

      menuBtn.click()
      webview.dispatchEvent(new Event('focus'))
      assert.ok(menu.hasAttribute('hidden'), 'focusing the guest page dismisses the menu')

      menuBtn.click()
      inspectorItem.click()
      assert.equal(devToolsOpens, 1, 'inspector item opens the guest devtools')
    } finally {
      globalThis.requestAnimationFrame = raf
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the global may be undefined in the test DOM, so restore only when it existed
      if (ResizeObserverCtor) globalThis.ResizeObserver = ResizeObserverCtor
      else delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
      unregisterAttachments()
      unmount()
    }
  })
})
