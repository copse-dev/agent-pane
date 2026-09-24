export const SVG_NS = 'http://www.w3.org/2000/svg'

/** Decimal places kept in serialised coordinates. */
export const D = 2

export function numSort(a: number, b: number): number {
  return a - b
}

export function splitNum(a: number): [magnitude: number, sign: 1 | -1] {
  return [Math.abs(a), a < 0 ? -1 : 1]
}

export function guid(): string {
  const s4 = (): string => (((1 + Math.random()) * 0x10000) | 0).toString(16).substring(1)
  return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`
}

/** An arrow-head marker wrapped in `<defs>`; reference it with `marker-end`. */
export function createArrowHead(id: string, fill: string): SVGDefsElement {
  const defs = document.createElementNS(SVG_NS, 'defs')
  const marker = document.createElementNS(SVG_NS, 'marker')
  const head = document.createElementNS(SVG_NS, 'path')
  head.setAttribute('fill', fill)
  marker.setAttribute('id', id)
  marker.setAttribute('viewBox', '0 -5 10 10')
  marker.setAttribute('refX', '5')
  marker.setAttribute('refY', '0')
  marker.setAttribute('markerWidth', '4')
  marker.setAttribute('markerHeight', '4')
  marker.setAttribute('orient', 'auto')
  head.setAttribute('d', 'M0,-5L10,0L0,5')
  marker.appendChild(head)
  defs.appendChild(marker)
  return defs
}

/** `getTotalLength` where the DOM implements it (jsdom does not); null otherwise. */
export function totalLength(el: SVGElement): number | null {
  const candidate: unknown = Reflect.get(el, 'getTotalLength')
  if (typeof candidate !== 'function') return null
  try {
    const length: unknown = Reflect.apply(candidate, el, [])
    return typeof length === 'number' ? length : null
  } catch {
    return null
  }
}
