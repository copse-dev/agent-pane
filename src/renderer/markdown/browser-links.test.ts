import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { bindBrowserLinkClicks } from './browser-links.ts'

describe('markdown browser links', () => {
  it('opens HTTP links in the browser panel', () => {
    const root = document.createElement('div')
    root.innerHTML = '<a href="https://example.com/docs" target="_blank">docs</a>'
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    const requested: string[] = []
    store.on('browser_url_requested', (url) => requested.push(url))
    const unbind = bindBrowserLinkClicks(root, store)

    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
    root.querySelector('a')!.dispatchEvent(event)

    unbind()
    assert.equal(event.defaultPrevented, true)
    assert.equal(store.getState().filesPaneOpen, true)
    assert.equal(store.getState().rightPanelMode, 'browser')
    assert.deepEqual(requested, ['https://example.com/docs'])
  })

  it('leaves generated file reference links to the file link handler', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<a href="#" data-file-reference-path="src/main/index.ts">src/main/index.ts</a>'
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    let requested = false
    store.on('browser_url_requested', () => (requested = true))
    const unbind = bindBrowserLinkClicks(root, store)

    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
    root.querySelector('a')!.dispatchEvent(event)

    unbind()
    assert.equal(event.defaultPrevented, false)
    assert.equal(requested, false)
  })
})
