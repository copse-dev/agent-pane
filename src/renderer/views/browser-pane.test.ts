import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { openBrowserUrl } from '../controller/panels.ts'
import { mountBrowserPane } from './browser-pane.ts'

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
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    }
    const ResizeObserverCtor = globalThis.ResizeObserver
    class NoopResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver

    const { list, viewer } = mountBrowserHosts()
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    const unmount = mountBrowserPane(list, viewer, store)

    try {
      openBrowserUrl(store, 'https://example.com/docs')

      const urlInput = viewer.querySelector('.browser-url-input') as HTMLInputElement | null
      assert.ok(urlInput)
      assert.match(urlInput.value, /example\.com\/docs/)

      const tabLabel = list.querySelector('.browser-tabs-tab-label')?.textContent
      assert.match(tabLabel ?? '', /example\.com/)
    } finally {
      globalThis.requestAnimationFrame = raf
      if (ResizeObserverCtor) globalThis.ResizeObserver = ResizeObserverCtor
      else delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
      unmount()
    }
  })
})
