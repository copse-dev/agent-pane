import '../../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDrauu } from './index.ts'
import { SVG_NS } from './utils.ts'

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

function mountSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  document.body.append(svg)
  return svg
}

/** A drag from (x0, y0) to (x1, y1) in `steps` moves; pointerdown on the svg, the rest on window. */
function drag(svg: SVGSVGElement, x0: number, y0: number, x1: number, y1: number, steps = 8): void {
  svg.dispatchEvent(pointer('pointerdown', x0, y0))
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    window.dispatchEvent(pointer('pointermove', x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
  }
  window.dispatchEvent(pointer('pointerup', x1, y1))
}

describe('vendored drauu', () => {
  it('commits a stylus stroke as a filled path child and serialises it', () => {
    const svg = mountSvg()
    const drauu = createDrauu({ el: svg, brush: { mode: 'stylus', color: '#e5484d', size: 6 } })
    try {
      drag(svg, 10, 10, 120, 60)
      assert.equal(svg.childElementCount, 1)
      const path = svg.firstElementChild
      assert.ok(path)
      assert.equal(path.tagName.toLowerCase(), 'path')
      assert.equal(path.getAttribute('fill'), '#e5484d')
      assert.match(path.getAttribute('d') ?? '', /^M [\d.]+ [\d.]+ Q .* Z$/)
      assert.equal(drauu.dump(), svg.innerHTML)
    } finally {
      drauu.unmount()
      svg.remove()
    }
  })

  it('undo removes the latest stroke, redo restores it in order, clear empties the stack', () => {
    const svg = mountSvg()
    const drauu = createDrauu({ el: svg })
    try {
      drag(svg, 0, 0, 50, 50)
      drag(svg, 0, 50, 50, 0)
      assert.equal(svg.childElementCount, 2)
      const [first, second] = Array.from(svg.children)
      assert.ok(first && second)

      assert.equal(drauu.undo(), true)
      assert.deepEqual(Array.from(svg.children), [first])
      assert.equal(drauu.canRedo(), true)

      assert.equal(drauu.redo(), true)
      assert.deepEqual(Array.from(svg.children), [first, second])
      assert.equal(drauu.canRedo(), false)

      drauu.clear()
      assert.equal(svg.childElementCount, 0)
      assert.equal(drauu.canUndo(), false)
      assert.equal(drauu.undo(), false)
    } finally {
      drauu.unmount()
      svg.remove()
    }
  })

  it('draws lines, rectangles and ellipses from the brush mode, with an arrow marker on request', () => {
    const svg = mountSvg()
    const drauu = createDrauu({ el: svg, brush: { mode: 'line', color: 'blue', size: 3 } })
    try {
      drag(svg, 10, 10, 90, 40)
      drauu.brush.arrowEnd = true
      drag(svg, 10, 50, 90, 80)
      drauu.mode = 'rectangle'
      drag(svg, 100, 10, 150, 60)
      drauu.mode = 'ellipse'
      drag(svg, 160, 10, 220, 60)

      const tags = Array.from(svg.children).map((c) => c.tagName.toLowerCase())
      assert.deepEqual(tags, ['line', 'g', 'rect', 'ellipse'])
      const arrow = svg.children[1]
      assert.ok(arrow)
      assert.equal(arrow.querySelector('marker')?.getAttribute('orient'), 'auto')
      assert.match(arrow.querySelector('line')?.getAttribute('marker-end') ?? '', /^url\(#/)
      const rect = svg.children.item(2)
      assert.ok(rect)
      assert.equal(rect.getAttribute('width'), '50.00')
      assert.equal(rect.getAttribute('height'), '50.00')
    } finally {
      drauu.unmount()
      svg.remove()
    }
  })

  it('ignores pointer types outside acceptsInputTypes', () => {
    const svg = mountSvg()
    const drauu = createDrauu({ el: svg, acceptsInputTypes: ['pen'] })
    try {
      drag(svg, 0, 0, 40, 40)
      assert.equal(svg.childElementCount, 0)
    } finally {
      drauu.unmount()
      svg.remove()
    }
  })

  it('stops listening after unmount', () => {
    const svg = mountSvg()
    const drauu = createDrauu({ el: svg })
    drauu.unmount()
    drag(svg, 0, 0, 40, 40)
    assert.equal(svg.childElementCount, 0)
    assert.equal(drauu.mounted, false)
    svg.remove()
  })
})
