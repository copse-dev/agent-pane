import '../../../tests/setup-dom.ts'
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { attachMermaidExpand } from './mermaid-expand.ts'
import { qs, qsRequired } from '../dom/helpers.ts'

// happy-dom doesn't implement <dialog> modality or pointer capture; stub the
// few methods the expand lightbox calls so the interaction wiring can run.
function patchEnv(): void {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
  proto['setPointerCapture'] ??= function (): void {}
  proto['hasPointerCapture'] ??= function (): boolean {
    return false
  }
  proto['releasePointerCapture'] ??= function (): void {}
  proto['showModal'] ??= function (this: HTMLElement): void {
    ;(this as unknown as { open: boolean }).open = true
  }
  proto['close'] ??= function (this: HTMLElement): void {
    ;(this as unknown as { open: boolean }).open = false
    this.dispatchEvent(new window.Event('close'))
  }
}

function diagram(withSvg = true): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = `<div class="mermaid-diagram">${withSvg ? '<svg><g></g></svg>' : '<pre>x</pre>'}</div>`
  return root
}

function mouseClick(target: EventTarget): void {
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
}

describe('attachMermaidExpand', () => {
  before(() => {
    patchEnv()
  })

  it('folds a rendered diagram and wires expand affordances', () => {
    const root = diagram()
    attachMermaidExpand(root)
    const el = qsRequired(root, '.mermaid-diagram')
    assert.equal(el.dataset['mermaidUi'], 'true')
    assert.equal(el.classList.contains('mermaid-diagram--folded'), true)
    assert.equal(el.getAttribute('role'), 'button')
    assert.equal(el.getAttribute('tabindex'), '0')
    assert.equal(el.getAttribute('aria-label'), 'Expand diagram')
  })

  it('skips diagrams already wired, errored, or without an svg', () => {
    const already = diagram()
    qsRequired(already, '.mermaid-diagram').setAttribute('data-mermaid-ui', 'true')
    attachMermaidExpand(already)
    assert.equal(qsRequired(already, '.mermaid-diagram').getAttribute('role'), null)

    const noSvg = diagram(false)
    attachMermaidExpand(noSvg)
    assert.equal(qsRequired(noSvg, '.mermaid-diagram').getAttribute('role'), null)

    const errored = document.createElement('div')
    errored.innerHTML =
      '<div class="mermaid-diagram"><svg></svg><span class="error-icon"></span></div>'
    attachMermaidExpand(errored)
    assert.equal(qsRequired(errored, '.mermaid-diagram').getAttribute('role'), null)
  })

  it('opens the lightbox on click and clones the svg into the stage', () => {
    const root = diagram()
    document.body.append(root)
    attachMermaidExpand(root)
    mouseClick(qsRequired(root, '.mermaid-diagram'))

    const dialog = qsRequired(document, '.mermaid-expand-dialog')
    assert.ok(qs(dialog, '.mermaid-expand-stage svg'), 'svg cloned into stage')
    assert.ok(qs(dialog, '.mermaid-expand-toolbar'))
  })

  it('opens on Enter/Space keydown', () => {
    const root = diagram()
    attachMermaidExpand(root)
    const el = qsRequired(root, '.mermaid-diagram')
    el.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    assert.ok(qs(document, '.mermaid-expand-dialog'))
    // A non-activating key is ignored (no throw).
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }))
  })

  it('zoom, pan, reset and close interactions run without error', () => {
    const root = diagram()
    attachMermaidExpand(root)
    mouseClick(qsRequired(root, '.mermaid-diagram'))

    const dialog = qsRequired(document, '.mermaid-expand-dialog')
    const viewport = qsRequired(dialog, '.mermaid-expand-viewport')
    const stage = qsRequired(dialog, '.mermaid-expand-stage')
    const zoomLabel = qsRequired(dialog, '.mermaid-expand-zoom-label')

    // Give the viewport/stage real geometry so fitToViewport takes its full path.
    viewport.getBoundingClientRect = (): DOMRect =>
      ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0 }) as DOMRect
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 })
    Object.defineProperty(stage, 'offsetWidth', { configurable: true, value: 200 })
    Object.defineProperty(stage, 'offsetHeight', { configurable: true, value: 100 })

    // Toolbar buttons: zoom in, zoom out, reset (fitToViewport with geometry).
    for (const label of ['Zoom in', 'Zoom out', 'Fit diagram to panel']) {
      mouseClick(qsRequired(dialog, `[aria-label="${label}"]`))
    }
    assert.match(zoomLabel.textContent, /%$/)

    // Wheel zoom + pointer pan.
    viewport.dispatchEvent(
      Object.assign(new window.Event('wheel', { cancelable: true }), {
        deltaY: -1,
        clientX: 100,
        clientY: 80,
      }),
    )
    viewport.dispatchEvent(
      Object.assign(new window.Event('pointerdown'), {
        button: 0,
        clientX: 10,
        clientY: 10,
        pointerId: 1,
      }),
    )
    viewport.dispatchEvent(
      Object.assign(new window.Event('pointermove'), { clientX: 40, clientY: 25, pointerId: 1 }),
    )
    viewport.dispatchEvent(Object.assign(new window.Event('pointerup'), { pointerId: 1 }))
    assert.match(stage.style.transform, /translate\(/)

    // Backdrop click (target === dialog) closes and resets the transform.
    dialog.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
})
