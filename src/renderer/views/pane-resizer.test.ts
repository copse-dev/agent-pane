import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { DEFAULT_LAYOUT, LAYOUT_LIMITS } from '@shared/types/layout.ts'
import { PORTRAIT_RIGHT_PANEL_CLASS } from './portrait-right-panel-layout.ts'
import { applyLayout, mountPaneResizers, parseSavedLayout } from './pane-resizer.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

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
    handle.setPointerCapture = (): void => {}
  }
  return body
}

function apiStub(): ApiClient {
  return ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      settings: {
        ...base['settings'],
        set: async (): Promise<void> => {},
      },
    } satisfies ApiClient
  })()
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
    assert.deepEqual(parseSavedLayout([]), DEFAULT_LAYOUT)
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

    const filesResizer = document.getElementById('resizer-files')
    assert.ok(filesResizer)
    dispatchPointer(filesResizer, 'pointerdown', { clientX: 200, clientY: 400, button: 0 })
    dispatchPointer(document, 'pointermove', { clientX: 200, clientY: 300 })
    assert.equal(store.getState().layout.filesPaneHeight, DEFAULT_LAYOUT.filesPaneHeight + 100)
    assert.equal(body.style.getPropertyValue('--files-height'), '460px')

    dispatchPointer(document, 'pointerup', { clientX: 200, clientY: 300 })
    assert.equal(document.body.style.cursor, '')
  })

  it('keeps chat at one third of the width shared with a side panel', () => {
    const body = mountResizableDom()
    const store = createStore({
      filesPaneOpen: true,
      layout: { ...DEFAULT_LAYOUT, filesPaneWidth: 4000 },
    })
    mountPaneResizers(body, store, apiStub())

    // 1000px body - 240px Projects = 760px shared by chat and the panel.
    assert.equal(store.getState().layout.filesPaneWidth, Math.floor((760 * 2) / 3))
    assert.equal(body.style.getPropertyValue('--files-width'), '506px')
  })

  it('preserves the chat share while widening the Projects pane', () => {
    const body = mountResizableDom()
    const store = createStore({ filesPaneOpen: true })
    mountPaneResizers(body, store, apiStub())

    const projectsResizer = document.getElementById('resizer-projects')
    assert.ok(projectsResizer)
    dispatchPointer(projectsResizer, 'pointerdown', { clientX: 240, clientY: 0, button: 0 })
    dispatchPointer(document, 'pointermove', { clientX: 400, clientY: 0 })

    // 1000px body - 400px Projects leaves 600px, so the side panel caps at 400px.
    assert.equal(store.getState().layout.projectsPaneWidth, 400)
    assert.equal(store.getState().layout.filesPaneWidth, 400)
  })
})
