import type { Drauu } from '../drauu.ts'
import type { Brush, Operation, Point } from '../types.ts'
import { D, SVG_NS } from '../utils.ts'

export abstract class BaseModel<T extends SVGElement> {
  point: Point | null = null
  start: Point | null = null
  el: T | null = null

  protected readonly drauu: Drauu

  constructor(drauu: Drauu) {
    this.drauu = drauu
  }

  onSelected(_el: SVGSVGElement | null): void {}

  onUnselected(): void {}

  onStart(_point: Point): SVGElement | undefined {
    return undefined
  }

  onMove(_point: Point): boolean {
    return false
  }

  onEnd(_point: Point): Operation | boolean | undefined {
    return undefined
  }

  get brush(): Brush {
    return this.drauu.brush
  }

  get shiftPressed(): boolean {
    return this.drauu.shiftPressed
  }

  get altPressed(): boolean {
    return this.drauu.altPressed
  }

  get svgElement(): SVGSVGElement | null {
    return this.drauu.el
  }

  getMousePosition(event: PointerEvent): Point {
    const el = this.drauu.el
    if (!el) return { x: event.clientX, y: event.clientY, pressure: event.pressure }

    const svgPoint = this.drauu.svgPoint
    const ctm =
      this.drauu.options.coordinateTransform !== false && typeof el.getScreenCTM === 'function'
        ? el.getScreenCTM()
        : null
    // happy-dom mints SVG points without matrixTransform; treat that like no CTM.
    if (svgPoint && ctm && typeof svgPoint.matrixTransform === 'function') {
      svgPoint.x = event.clientX
      svgPoint.y = event.clientY
      const loc = svgPoint.matrixTransform(ctm.inverse())
      return { x: loc.x, y: loc.y, pressure: event.pressure }
    }

    const rect = el.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, pressure: event.pressure }
  }

  protected createElement<K extends keyof SVGElementTagNameMap>(
    name: K,
    overrides?: Partial<Brush>,
  ): SVGElementTagNameMap[K] {
    const el = document.createElementNS(SVG_NS, name)
    const brush = overrides ? { ...this.brush, ...overrides } : this.brush

    el.setAttribute('fill', brush.fill ?? 'transparent')
    el.setAttribute('stroke', brush.color)
    el.setAttribute('stroke-width', brush.size.toString())
    el.setAttribute('stroke-linecap', 'round')
    if (brush.dasharray) el.setAttribute('stroke-dasharray', brush.dasharray)
    return el
  }

  protected attr(name: string, value: string | number): void {
    this.el?.setAttribute(name, typeof value === 'string' ? value : value.toFixed(D))
  }

  private setEvent(event: PointerEvent): Point {
    this.point = this.getMousePosition(event)
    return this.point
  }

  /** @internal */
  _eventDown(event: PointerEvent): SVGElement | undefined {
    const point = this.setEvent(event)
    this.start = point
    return this.onStart(point)
  }

  /** @internal */
  _eventMove(event: PointerEvent): boolean {
    return this.onMove(this.setEvent(event))
  }

  /** @internal */
  _eventUp(event: PointerEvent): Operation | boolean | undefined {
    return this.onEnd(this.setEvent(event))
  }
}
