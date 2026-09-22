// Minimal pen input + perfect-freehand outline helpers shared by the two
// perfect-freehand pages. Framework-free; the SVG DOM is the model.
import { getStroke } from 'https://cdn.jsdelivr.net/npm/perfect-freehand@1.2.3/+esm'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** perfect-freehand's documented outline-to-path conversion (quadratic midpoints). */
export function getSvgPathFromStroke(points) {
  const len = points.length
  if (len < 4) return ''
  let a = points[0]
  let b = points[1]
  const c = points[2]
  let result = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} ${avg(b[0], c[0]).toFixed(2)},${avg(b[1], c[1]).toFixed(2)} T`
  for (let i = 2, max = len - 1; i < max; i++) {
    a = points[i]
    b = points[i + 1]
    result += `${avg(a[0], b[0]).toFixed(2)},${avg(a[1], b[1]).toFixed(2)} `
  }
  return result + 'Z'
}
const avg = (a, b) => (a + b) / 2

export function outlinePath(inputPoints, options) {
  return getSvgPathFromStroke(getStroke(inputPoints, options))
}

/**
 * Same curve as getSvgPathFromStroke but with every quadratic spelled out
 * (no `T` shorthand), for parsers that lack it such as js-draw's Path.
 */
export function getExplicitQuadPathFromStroke(points) {
  const len = points.length
  if (len < 4) return ''
  const f = (n) => n.toFixed(2)
  let d = `M${f(points[0][0])},${f(points[0][1])}`
  for (let i = 1; i < len; i++) {
    const c = points[i]
    const n = points[(i + 1) % len]
    d += ` Q${f(c[0])},${f(c[1])} ${f(avg(c[0], n[0]))},${f(avg(c[1], n[1]))}`
  }
  return d + ' Z'
}

export function outlinePathExplicit(inputPoints, options) {
  return getExplicitQuadPathFromStroke(getStroke(inputPoints, options))
}

export function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

/**
 * Wire pointer events on `svg`. `handlers.start/move/end` receive
 * `{ x, y, pressure, pointerType, points }` where `points` is the full
 * [x, y, pressure] list for the gesture so far.
 */
export function attachPointer(svg, handlers) {
  let active = null
  const toLocal = (e) => {
    const r = svg.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top, e.pressure || 0.5]
  }
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    svg.setPointerCapture(e.pointerId)
    const p = toLocal(e)
    active = { id: e.pointerId, points: [p], pointerType: e.pointerType }
    handlers.start?.({ x: p[0], y: p[1], pressure: p[2], pointerType: e.pointerType, points: active.points })
  })
  svg.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== active.id) return
    // Coalesced events give the full stylus sample rate rather than one
    // point per animation frame.
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e]
    for (const ce of events.length ? events : [e]) active.points.push(toLocal(ce))
    const p = active.points[active.points.length - 1]
    handlers.move?.({ x: p[0], y: p[1], pressure: p[2], pointerType: active.pointerType, points: active.points })
  })
  const finish = (e) => {
    if (!active || e.pointerId !== active.id) return
    const gesture = active
    active = null
    const p = gesture.points[gesture.points.length - 1]
    handlers.end?.({ x: p[0], y: p[1], pressure: p[2], pointerType: gesture.pointerType, points: gesture.points })
  }
  svg.addEventListener('pointerup', finish)
  svg.addEventListener('pointercancel', finish)
}

/** Undo/redo stack over "append/remove one SVG node" operations. */
export function createHistory(svg) {
  const undo = []
  const redo = []
  return {
    commit(node) {
      svg.appendChild(node)
      undo.push(node)
      redo.length = 0
    },
    undo() {
      const n = undo.pop()
      if (!n) return
      n.remove()
      redo.push(n)
    },
    redo() {
      const n = redo.pop()
      if (!n) return
      svg.appendChild(n)
      undo.push(n)
    },
    clear() {
      for (const n of undo) n.remove()
      undo.length = 0
      redo.length = 0
    },
    get size() { return undo.length },
  }
}
