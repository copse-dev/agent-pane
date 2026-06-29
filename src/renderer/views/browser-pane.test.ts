import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { openBrowserUrl, openCanvasArtefact } from '../controller/panels.ts'
import { mountBrowserPane } from './browser-pane.ts'

interface FakeWebview extends HTMLElement {
  src: string
  getURL(): string
  canGoBack(): boolean
  canGoForward(): boolean
  reload(): void
}

/** Stub the guest-webview methods jsdom lacks so `dom-ready` handlers can run. */
function stubWebviewMethods(webview: FakeWebview): void {
  webview.getURL = (): string => 'about:blank'
  webview.canGoBack = (): boolean => false
  webview.canGoForward = (): boolean => false
  webview.reload = (): void => {}
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
      const webview = activePanel?.querySelector('.browser-webview') as FakeWebview | null
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
      const urlInput = activePanel?.querySelector('.browser-url-input') as HTMLInputElement
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
})
