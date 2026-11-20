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

function button(el: HTMLElement, selector: string): HTMLButtonElement {
  const found = el.querySelector<HTMLButtonElement>(selector)
  assert.ok(found, `expected ${selector}`)
  return found
}

/**
 * happy-dom lays nothing out, so every strip "fits". Give the strip the widths
 * a browser measures for each layout (1x scale) and the host a width to fit in.
 */
function measurableStrip(el: HTMLElement, hostWidth: number): HTMLElement {
  const strip = el.querySelector<HTMLElement>('.annotation-toolstrip')
  assert.ok(strip, 'tool strip mounted')
  Object.defineProperty(strip, 'scrollWidth', {
    configurable: true,
    get: (): number => {
      const { send, shapes, spacing } = strip.dataset
      if (shapes === 'each') return send === 'long' ? 419 : 376
      return spacing === 'regular' ? 293 : 243
    },
  })
  Object.defineProperty(strip, 'clientWidth', {
    configurable: true,
    get: (): number => hostWidth - 16,
  })
  return strip
}

/**
 * Stand in for ResizeObserver, which happy-dom never fires. `fire()` delivers
 * a resize to every live observer; `targets` are the elements being watched.
 */
function fakeResizeObserver(): {
  targets: Element[]
  fire: () => void
  allDisconnected: () => boolean
  restore: () => void
} {
  const had = Object.hasOwn(globalThis, 'ResizeObserver')
  const previous = globalThis.ResizeObserver
  const observers: { callback: () => void; disconnected: boolean }[] = []
  const targets: Element[] = []
  class FakeResizeObserver {
    readonly entry: { callback: () => void; disconnected: boolean }
    constructor(callback: ResizeObserverCallback) {
      this.entry = {
        callback: (): void => {
          callback([], this)
        },
        disconnected: false,
      }
      observers.push(this.entry)
    }
    observe(target: Element): void {
      targets.push(target)
    }
    unobserve(): void {}
    disconnect(): void {
      this.entry.disconnected = true
    }
  }
  globalThis.ResizeObserver = FakeResizeObserver
  return {
    targets,
    fire: (): void => {
      for (const observer of observers) if (!observer.disconnected) observer.callback()
    },
    allDisconnected: (): boolean => observers.length > 0 && observers.every((o) => o.disconnected),
    restore: (): void => {
      if (had) globalThis.ResizeObserver = previous
      else Reflect.deleteProperty(globalThis, 'ResizeObserver')
    },
  }
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
      button(el, '.annotation-ink').click()
      button(el, '.annotation-swatch[aria-label="Blue"]').click()
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
      assert.equal(button(el, '.annotation-ink').getAttribute('aria-label'), 'Ink colour: Blue')
    } finally {
      layer.dispose()
      el.remove()
    }
  })

  it('keeps ink behind one button: no swatches on the strip, four in its menu', () => {
    const el = host()
    const layer = mountAnnotationLayer(el, { label: 'page', onSend: () => true })
    try {
      layer.activate()
      const ink = button(el, '.annotation-ink')
      assert.equal(el.querySelector('.annotation-swatch'), null)
      assert.equal(ink.getAttribute('aria-label'), 'Ink colour: Red')
      assert.equal(ink.style.getPropertyValue('--annotation-swatch'), '#e5484d')
      assert.equal(ink.getAttribute('aria-expanded'), 'false')

      ink.click()
      assert.equal(ink.getAttribute('aria-expanded'), 'true')
      const menu = el.querySelector('.annotation-popover')
      assert.ok(menu)
      assert.equal(menu.getAttribute('aria-label'), 'Ink colour')
      const swatches = Array.from(menu.querySelectorAll('.annotation-swatch'))
      assert.deepEqual(
        swatches.map((swatch) => swatch.getAttribute('aria-label')),
        ['Red', 'Blue', 'Green', 'Yellow'],
      )
      const pressed = swatches.filter((swatch) => swatch.getAttribute('aria-pressed') === 'true')
      assert.deepEqual(
        pressed.map((swatch) => swatch.getAttribute('aria-label')),
        ['Red'],
      )
      assert.equal(document.activeElement, pressed[0], 'the current ink takes focus')

      button(el, '.annotation-swatch[aria-label="Green"]').click()
      assert.equal(el.querySelector('.annotation-popover'), null, 'a pick closes the menu')
      assert.equal(ink.getAttribute('aria-expanded'), 'false')
      assert.equal(ink.getAttribute('aria-label'), 'Ink colour: Green')
      assert.equal(ink.style.getPropertyValue('--annotation-swatch'), '#22c55e')
      assert.equal(document.activeElement, ink, 'focus returns to the strip')

      drag(surfaceOf(el), 20, 20, 120, 80)
      assert.equal(surfaceOf(el).children.item(0)?.getAttribute('data-colour'), '#22c55e')
    } finally {
      layer.dispose()
      el.remove()
    }
  })

  it('dismisses the ink menu on its own button, an outside press, or a tool change', () => {
    const el = host()
    const layer = mountAnnotationLayer(el, { label: 'page', onSend: () => true })
    try {
      layer.activate()
      const ink = button(el, '.annotation-ink')
      const open = (): boolean => el.querySelector('.annotation-popover') !== null

      ink.click()
      assert.equal(open(), true)
      // The press that lands on the menu's own button is left to its click.
      ink.dispatchEvent(pointer('pointerdown', 0, 0))
      assert.equal(open(), true)
      ink.click()
      assert.equal(open(), false, 'its button toggles it')

      ink.click()
      button(el, '.annotation-swatch[aria-label="Blue"]').dispatchEvent(
        pointer('pointerdown', 0, 0),
      )
      assert.equal(open(), true, 'a press inside the menu keeps it')
      surfaceOf(el).dispatchEvent(pointer('pointerdown', 200, 200))
      window.dispatchEvent(pointer('pointerup', 200, 200))
      assert.equal(open(), false, 'a press on the page dismisses it')

      ink.click()
      button(el, '[data-tool="line"]').click()
      assert.equal(open(), false, 'choosing a tool dismisses it')

      ink.click()
      layer.deactivate()
      assert.equal(open(), false, 'leaving annotation mode dismisses it')
    } finally {
      layer.dispose()
      el.remove()
    }
  })

  it('Escape closes an open menu first, then leaves annotation mode', () => {
    const el = host()
    const layer = mountAnnotationLayer(el, { label: 'page', onSend: () => true })
    try {
      layer.activate()
      button(el, '.annotation-ink').click()
      const escape = (): void => {
        window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      }
      escape()
      assert.equal(el.querySelector('.annotation-popover'), null)
      assert.equal(layer.active, true, 'the first Escape belongs to the menu')
      escape()
      assert.equal(layer.active, false)
    } finally {
      layer.dispose()
      el.remove()
    }
  })

  it('gives up the long label, then the shape buttons, then its spacing as the host narrows', () => {
    const el = host()
    const layer = mountAnnotationLayer(el, { label: 'page', onSend: () => true })
    const layoutAt = (width: number): string => {
      layer.deactivate()
      const strip = measurableStrip(el, width)
      layer.activate()
      const { send, shapes, spacing } = strip.dataset
      return `${send ?? ''} ${shapes ?? ''} ${spacing ?? ''} "${button(el, '.annotation-send').textContent}"`
    }
    try {
      layer.activate()
      assert.equal(layoutAt(560), 'long each regular "Send to agent"')
      assert.equal(layoutAt(435), 'long each regular "Send to agent"')
      assert.equal(layoutAt(434), 'short each regular "Send"')
      assert.equal(layoutAt(391), 'short folded regular "Send"')
      assert.equal(layoutAt(308), 'short folded tight "Send"')
      assert.equal(layoutAt(200), 'short folded tight "Send"', 'nothing fits: keep the narrowest')
      assert.equal(
        button(el, '.annotation-send').getAttribute('aria-label'),
        'Send to agent',
        'the compact label keeps the full name',
      )
      assert.equal(layoutAt(560), 'long each regular "Send to agent"', 'room returning restores it')
    } finally {
      layer.dispose()
      el.remove()
    }
  })

  it('never shortens a label the caller chose', () => {
    const el = host()
    const layer = mountAnnotationLayer(el, {
      label: 'page',
      actionLabel: 'Update',
      onSend: () => true,
    })
    try {
      layer.activate()
      layer.deactivate()
      const strip = measurableStrip(el, 320)
      layer.activate()
      assert.equal(strip.dataset['shapes'], 'folded')
      assert.equal(button(el, '.annotation-send').textContent, 'Update')
    } finally {
      layer.dispose()
      el.remove()
    }
  })

  it('folded shapes share one button: it takes the last shape, then opens the rest', () => {
    const el = host()
    const layer = mountAnnotationLayer(el, { label: 'page', onSend: () => true })
    try {
      layer.activate()
      layer.deactivate()
      measurableStrip(el, 360)
      layer.activate()
      const svg = surfaceOf(el)
      const fold = button(el, '.annotation-shape-fold')
      assert.equal(fold.getAttribute('aria-label'), 'Arrow')
      assert.equal(fold.getAttribute('aria-pressed'), 'false')

      fold.click()
      assert.equal(fold.getAttribute('aria-pressed'), 'true')
      assert.equal(el.querySelector('.annotation-popover'), null, 'the first press only selects')
      drag(svg, 10, 10, 80, 50)
      assert.ok(svg.children.item(0)?.querySelector('marker'), 'it drew an arrow')

      fold.click()
      const menu = el.querySelector('.annotation-popover')
      assert.ok(menu, 'the second press opens the shapes')
      assert.equal(fold.getAttribute('aria-expanded'), 'true')
      assert.deepEqual(
        Array.from(menu.querySelectorAll<HTMLElement>('[data-tool]')).map((b) => b.dataset['tool']),
        ['line', 'arrow', 'rect', 'ellipse'],
      )
      button(el, '.annotation-popover [data-tool="rect"]').click()
      assert.equal(el.querySelector('.annotation-popover'), null)
      assert.equal(fold.getAttribute('aria-label'), 'Rectangle', 'it now stands for the rectangle')
      assert.equal(fold.querySelector('svg')?.getAttribute('data-icon'), 'square')
      assert.equal(document.activeElement, fold)
      drag(svg, 100, 10, 160, 50)
      assert.equal(svg.children.item(1)?.tagName.toLowerCase(), 'rect')

      // Another tool takes over; the fold keeps the rectangle for next time.
      button(el, '[data-tool="pen"]').click()
      assert.equal(fold.getAttribute('aria-pressed'), 'false')
      fold.click()
      assert.equal(fold.getAttribute('aria-pressed'), 'true')
      drag(svg, 100, 100, 160, 140)
      assert.equal(svg.children.item(2)?.tagName.toLowerCase(), 'rect')

      // Re-entering the mode focuses the button that is on screen for the tool.
      layer.deactivate()
      layer.activate()
      assert.equal(document.activeElement, fold)
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

  it('Send hands the export to onSend, then keeps the marks in place', async () => {
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
      // The annotation survives being sent: the mode leaves, the marks stay.
      assert.equal(layer.isEmpty(), false)
      assert.equal(layer.active, false)
      assert.equal(el.querySelector<HTMLElement>('.annotation-layer')?.hidden, false)
      // …and can be sent again (or edited) without redrawing.
      layer.activate()
      el.querySelector<HTMLButtonElement>('.annotation-send')?.click()
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(sent.length, 2)
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

  it('setScrollOffset shifts the live viewBox and the exported crop', async () => {
    const el = host()
    const layer = mountAnnotationLayer(el, { label: 'page', onSend: () => true })
    try {
      layer.activate()
      const svg = surfaceOf(el)
      // Drawing happens through the same viewBox, so the recorded stroke lands
      // in page space even after the offset moves.
      layer.setScrollOffset(0, 240)
      assert.equal(svg.getAttribute('viewBox'), '0 240 400 300')
      drag(svg, 20, 260, 120, 320)

      const payload = await layer.export()
      assert.match(payload.svg, /viewBox="0 240 400 300"/)
      assert.match(payload.svg, /fill="#e5484d"/)

      layer.setScrollOffset(100, 0)
      assert.equal(svg.getAttribute('viewBox'), '100 0 400 300')
      const again = await layer.export()
      assert.match(again.svg, /viewBox="100 0 400 300"/)
    } finally {
      layer.dispose()
      el.remove()
    }
  })

  it('ignores non-finite scroll offsets but keeps a negative X', () => {
    const el = host()
    const layer = mountAnnotationLayer(el, { label: 'page', onSend: () => true })
    try {
      layer.activate()
      const svg = surfaceOf(el)
      layer.setScrollOffset(Number.NaN, Number.POSITIVE_INFINITY)
      assert.equal(svg.getAttribute('viewBox'), '0 0 400 300')
      layer.setScrollOffset(-120, 60)
      assert.equal(svg.getAttribute('viewBox'), '-120 60 400 300')
      layer.setScrollOffset(Number.NaN, 90)
      assert.equal(svg.getAttribute('viewBox'), '-120 90 400 300', 'a bad axis keeps its value')
    } finally {
      layer.dispose()
      el.remove()
    }
  })

  it('re-applies the viewBox when the host resizes, even with no scroll change', () => {
    const resizes = fakeResizeObserver()
    const el = host()
    const layer = mountAnnotationLayer(el, { label: 'page', onSend: () => true })
    try {
      layer.activate()
      layer.setScrollOffset(0, 240)
      const svg = surfaceOf(el)
      assert.equal(svg.getAttribute('viewBox'), '0 240 400 300')
      el.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 640, 480)
      resizes.fire()
      assert.equal(svg.getAttribute('viewBox'), '0 240 640 480')
      layer.dispose()
      assert.ok(resizes.allDisconnected())
    } finally {
      layer.dispose()
      el.remove()
      resizes.restore()
    }
  })

  it('refits and drops an open menu on a resize of the host or of the interface scale', () => {
    const resizes = fakeResizeObserver()
    const el = host()
    const layer = mountAnnotationLayer(el, { label: 'page', onSend: () => true })
    try {
      layer.activate()
      // The host, and a probe sized in the interface scale: a scale change
      // grows the strip without resizing the host, and arrives through the probe.
      const probe = el.querySelector('.annotation-layer > .annotation-scale-probe')
      assert.ok(probe)
      assert.deepEqual(resizes.targets, [el, probe])

      const strip = measurableStrip(el, 560)
      resizes.fire()
      assert.equal(strip.dataset['shapes'], 'each')
      const ink = button(el, '.annotation-ink')
      ink.click()
      assert.ok(el.querySelector('.annotation-popover'))

      // Same layout before and after: the strip still re-centres, so the menu,
      // placed once under where its button was, must not be left behind.
      resizes.fire()
      assert.equal(strip.dataset['shapes'], 'each')
      assert.equal(el.querySelector('.annotation-popover'), null)
      assert.equal(ink.getAttribute('aria-expanded'), 'false')

      measurableStrip(el, 360)
      resizes.fire()
      assert.equal(strip.dataset['shapes'], 'folded', 'a resize refits')
    } finally {
      layer.dispose()
      el.remove()
      resizes.restore()
    }
  })

  it('names its menu buttons as expanding groups, not menus', () => {
    const el = host()
    const layer = mountAnnotationLayer(el, { label: 'page', onSend: () => true })
    try {
      layer.activate()
      for (const selector of ['.annotation-ink', '.annotation-shape-fold']) {
        const opener = button(el, selector)
        // aria-haspopup would announce a menu; the popup is a group of toggle buttons.
        assert.equal(opener.hasAttribute('aria-haspopup'), false, selector)
        assert.equal(opener.getAttribute('aria-expanded'), 'false', selector)
      }
      button(el, '.annotation-ink').click()
      assert.equal(el.querySelector('.annotation-popover')?.getAttribute('role'), 'group')
    } finally {
      layer.dispose()
      el.remove()
    }
  })
})
