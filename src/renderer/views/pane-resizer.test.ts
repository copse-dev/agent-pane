import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { DEFAULT_LAYOUT, LAYOUT_LIMITS } from '@shared/types/layout.ts'
import { PORTRAIT_RIGHT_PANEL_CLASS } from './portrait-right-panel-layout.ts'
import { applyLayout, mountPaneResizers, parseSavedLayout } from './pane-resizer.ts'
import type { ApiClient } from '../../preload/api.d.ts'

function dispatchPointer(target: EventTarget, type: string, init: MouseEventInit): void {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperties(event, {
    button: { configurable: true, value: init.button ?? 0 },
    clientX: { configurable: true, value: init.clientX ?? 0 },
    clientY: { configurable: true, value: init.clientY ?? 0 },
    pointerId: { configurable: true, value: 1 },
  })
  target.dispatchEvent(event)
}

function mountResizableDom(): HTMLElement {
  const body = document.createElement('div')
  body.id = 'body'
  body.innerHTML = `
    <div id="resizer-projects"></div>
    <div id="resizer-files"></div>
    <div id="resizer-tree"></div>
  `
  Object.defineProperties(body, {
    clientWidth: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 900 },
  })
  document.body.append(body)
  for (const handle of body.querySelectorAll<HTMLElement>('div')) {
    handle.setPointerCapture = () => {}
  }
  return body
}

function apiStub(): ApiClient {
  return {
    settings: {
      set: async () => {},
    },
  } as unknown as ApiClient
}

afterEach(() => {
  document.body.replaceChildren()
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})

describe('pane resizer', () => {
  it('parses and applies the saved stacked files pane height', () => {
    const layout = parseSavedLayout({ filesPaneHeight: 420 })
    assert.equal(layout.filesPaneHeight, 420)

    const body = document.createElement('div')
    applyLayout(body, layout)
    assert.equal(body.style.getPropertyValue('--files-height'), '420px')
  })

  it('falls back for invalid saved stacked files pane heights', () => {
    assert.equal(
      parseSavedLayout({ filesPaneHeight: 100 }).filesPaneHeight,
      LAYOUT_LIMITS.filesStacked.min,
    )
    assert.equal(
      parseSavedLayout({ filesPaneHeight: Number.NaN }).filesPaneHeight,
      DEFAULT_LAYOUT.filesPaneHeight,
    )
  })

  it('uses vertical pointer movement for the files pane in stacked layout', () => {
    const body = mountResizableDom()
    body.classList.add(PORTRAIT_RIGHT_PANEL_CLASS)
    const store = createStore({ filesPaneOpen: true })
    mountPaneResizers(body, store, apiStub())

    const filesResizer = document.getElementById('resizer-files')!
    dispatchPointer(filesResizer, 'pointerdown', { clientX: 200, clientY: 400, button: 0 })
    dispatchPointer(document, 'pointermove', { clientX: 200, clientY: 300 })
    assert.equal(store.getState().layout.filesPaneHeight, DEFAULT_LAYOUT.filesPaneHeight + 100)
    assert.equal(body.style.getPropertyValue('--files-height'), '460px')

    dispatchPointer(document, 'pointerup', { clientX: 200, clientY: 300 })
    assert.equal(document.body.style.cursor, '')
  })
})
