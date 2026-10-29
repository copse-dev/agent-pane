import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { panelModeLabel } from '../views/panel-mode-controls.ts'
import { mountPopoutTitlebar } from './popout-titlebar.ts'

afterEach(() => {
  document.body.replaceChildren()
})

describe('pop-out titlebar', () => {
  it('retitles from rightPanelMode alone, with no event emitted', () => {
    const originalResizeObserver = globalThis.ResizeObserver
    class TestResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = TestResizeObserver
    const host = document.createElement('div')
    document.body.append(host)
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'explorer' })

    let destroy: (() => void) | undefined
    try {
      destroy = mountPopoutTitlebar(host, store, createFakeApi())
      const title = host.querySelector('.popout-titlebar-title')
      assert.ok(title)
      assert.equal(title.textContent, panelModeLabel('explorer'))

      store.setState({ rightPanelMode: 'browser' })
      assert.equal(title.textContent, panelModeLabel('browser'))
    } finally {
      destroy?.()
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})
