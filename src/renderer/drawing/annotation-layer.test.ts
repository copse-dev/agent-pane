import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mountAnnotationLayer, type AnnotationExport } from './annotation-layer.ts'

function pointer(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType: 'mouse',
    pressure: 0.5,
  })
}

/**
 * happy-dom reports every geometry element as zero-length, which the shape
 * models read as an accidental tap. Give shapes a measurable length so the
 * commit path is exercised.
 */
function measurableShapes(): void {
  const proto: unknown = Reflect.get(window, 'SVGGeometryElement')
  if (typeof proto === 'function' && 'prototype' in proto) {
    Object.defineProperty(proto.prototype, 'getTotalLength', {
      configurable: true,
      value: (): number => 100,
    })
  }
}
measurableShapes()

function host(): HTMLElement {
  const el = document.createElement('div')
  el.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 400, 300)
  document.body.append(el)
  return el
}

function drag(surface: Element, x0: number, y0: number, x1: number, y1: number): void {
  surface.dispatchEvent(pointer('pointerdown', x0, y0))
  for (let i = 1; i <= 6; i++) {
    const t = i / 6
    window.dispatchEvent(pointer('pointermove', x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
  }
  window.dispatchEvent(pointer('pointerup', x1, y1))
}

function surfaceOf(el: HTMLElement): SVGSVGElement {
  const svg = el.querySelector<SVGSVGElement>('svg.annotation-layer-svg')
  assert.ok(svg, 'annotation svg mounted')
  return svg
}

describe('annotation layer', () => {
  it('mounts nothing until activated, then shows the tool strip over the host', () => {
    const el = host()
    const layer = mountAnnotationLayer(el, { label: 'Pricing page', onSend: () => true })
    try {
      assert.equal(el.querySelector('.annotation-layer'), null)
      assert.equal(layer.active, false)

      layer.activate()
      const root = el.querySelector<HTMLElement>('.annotation-layer')
      assert.ok(root)
      assert.equal(root.hidden, false)
      assert.equal(root.dataset['active'], 'true')
      assert.equal(surfaceOf(el).getAttribute('aria-label'), 'Annotations over Pricing page')
      const tools = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-tool]')).map(
        (b) => b.dataset['tool'],
      )
      assert.deepEqual(tools, ['pen', 'line', 'arrow', 'rect', 'ellipse', 'eraser'])
      assert.equal(root.querySelector('[data-tool="pen"]')?.getAttribute('aria-pressed'), 'true')
      assert.equal(root.querySelector<HTMLButtonElement>('.annotation-send')?.disabled, true)
    } finally {
      layer.dispose()
      el.remove()
    }
  })

  it('a pen drag adds a mark, enables Send, and export carries it as sized SVG', async () => {
    const el = host()
    const layer = mountAnnotationLayer(el, { label: 'page', onSend: () => true })
    try {
      layer.activate()
      const svg = surfaceOf(el)
      drag(svg, 20, 20, 200, 120)
      assert.equal(layer.isEmpty(), false)
      assert.equal(el.querySelector<HTMLButtonElement>('.annotation-send')?.disabled, false)

      const payload = await layer.export()
      const mark = payload.marks[0]
      assert.ok(mark)
      assert.equal(payload.marks.length, 1)
      assert.equal(mark.tool, 'pen')
      assert.equal(mark.colour, '#e5484d')
      assert.equal(payload.width, 400)
      assert.equal(payload.height, 300)
      assert.match(payload.svg, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
      assert.match(payload.svg, /viewBox="0 0 400 300"/)
      assert.match(payload.svg, /<path[^>]*fill="#e5484d"/)
      assert.doesNotMatch(payload.svg, /class="annotation-layer-svg"/)
    } finally {
      layer.dispose()
      el.remove()
    }
  })

  it('tools map onto drauu modes: rect draws a rect, a swatch recolours, arrow adds a marker', () => {
    const el = host()
    const layer = mountAnnotationLayer(el, { label: 'page', onSend: () => true })
    try {
      layer.activate()
      const svg = surfaceOf(el)
      el.querySelector<HTMLButtonElement>('[data-tool="rect"]')?.click()
      el.querySelector<HTMLButtonElement>('.annotation-swatch[aria-label="Blue"]')?.click()
      drag(svg, 10, 10, 60, 40)
      layer.setTool('arrow')
      drag(svg, 100, 10, 160, 40)

      const rect = svg.children.item(0)
      assert.ok(rect)
      assert.equal(rect.tagName.toLowerCase(), 'rect')
      assert.equal(rect.getAttribute('stroke'), '#3b82f6')
      const arrow = svg.children.item(1)
      assert.ok(arrow)
      assert.equal(arrow.tagName.toLowerCase(), 'g')
      assert.ok(arrow.querySelector('marker'))
      assert.equal(
        el.querySelector('.annotation-swatch[aria-label="Blue"]')?.getAttribute('aria-pressed'),
        'true',
      )
    } finally {
      layer.dispose()
      el.remove()
    }
  })

  it('Done keeps the marks visible but inert; Clear hides the layer; Escape deactivates', () => {
    const el = host()
    let deactivated = 0
    const layer = mountAnnotationLayer(el, {
      label: 'page',
      onSend: () => true,
      onDeactivate: () => {
        deactivated += 1
      },
    })
    try {
      layer.activate()
      drag(surfaceOf(el), 0, 0, 50, 50)
      const root = el.querySelector<HTMLElement>('.annotation-layer')
      assert.ok(root)

      el.querySelector<HTMLButtonElement>('[aria-label="Done"]')?.click()
      assert.equal(layer.active, false)
      assert.equal(deactivated, 1)
      assert.equal(root.hidden, false, 'marks stay on screen')
      assert.equal(root.dataset['active'], 'false')

      layer.activate()
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      assert.equal(layer.active, false)
      assert.equal(deactivated, 2)

      layer.clear()
      assert.equal(root.hidden, true, 'nothing left to show')
    } finally {
      layer.dispose()
      el.remove()
    }
  })

  it('Send hands the export to onSend, then consumes an accepted annotation', async () => {
    const el = host()
    const sent: AnnotationExport[] = []
    let captured = 0
    const layer = mountAnnotationLayer(el, {
      label: 'page',
      captureBase: async (): Promise<string | null> => {
        captured += 1
        return 'data:image/png;base64,AAAA'
      },
      onSend: (payload) => {
        sent.push(payload)
        return true
      },
    })
    try {
      layer.activate()
      drag(surfaceOf(el), 0, 0, 80, 20)
      el.querySelector<HTMLButtonElement>('.annotation-send')?.click()
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(sent.length, 1)
      assert.equal(captured, 1)
      const payload = sent[0]
      assert.ok(payload)
      assert.equal(payload.marks.length, 1)
      // happy-dom has no canvas, so neither composition attempt can produce a raster.
      assert.equal(payload.png, null)
      assert.equal(payload.captured, false)
      assert.equal(layer.isEmpty(), true)
      assert.equal(layer.active, false)
      assert.equal(el.querySelector<HTMLElement>('.annotation-layer')?.hidden, true)
    } finally {
      layer.dispose()
      el.remove()
    }
  })

  it('keeps marks available when the caller cannot attach the export', async () => {
    const el = host()
    const layer = mountAnnotationLayer(el, {
      label: 'page',
      onSend: () => false,
    })
    try {
      layer.activate()
      drag(surfaceOf(el), 0, 0, 80, 20)
      el.querySelector<HTMLButtonElement>('.annotation-send')?.click()
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))

      assert.equal(layer.isEmpty(), false)
      assert.equal(layer.active, true)
      assert.equal(el.querySelector<HTMLButtonElement>('.annotation-send')?.disabled, false)
    } finally {
      layer.dispose()
      el.remove()
    }
  })

  it('dispose removes the overlay and its window listeners', () => {
    const el = host()
    const layer = mountAnnotationLayer(el, { label: 'page', onSend: () => true })
    layer.activate()
    const svg = surfaceOf(el)
    layer.dispose()
    assert.equal(el.querySelector('.annotation-layer'), null)
    drag(svg, 0, 0, 30, 30)
    assert.equal(svg.childElementCount, 0)
    el.remove()
  })
})
