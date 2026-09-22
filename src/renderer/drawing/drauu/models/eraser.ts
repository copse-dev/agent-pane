import type { Operation, Point } from '../types.ts'
import { SVG_NS } from '../utils.ts'
import { BaseModel } from './base.ts'

interface Segment {
  x1: number
  y1: number
  x2: number
  y2: number
}

interface PathFragment extends Segment {
  element: Element
}

interface Measurable {
  getTotalLength(): number
  getPointAtLength(distance: number): { x: number; y: number }
}

function measurable(el: Element): Measurable | null {
  const getTotalLength: unknown = Reflect.get(el, 'getTotalLength')
  const getPointAtLength: unknown = Reflect.get(el, 'getPointAtLength')
  if (typeof getTotalLength !== 'function' || typeof getPointAtLength !== 'function') return null
  return {
    getTotalLength: (): number => {
      const n: unknown = Reflect.apply(getTotalLength, el, [])
      return typeof n === 'number' ? n : 0
    },
    getPointAtLength: (d: number): { x: number; y: number } => {
      const p: unknown = Reflect.apply(getPointAtLength, el, [d])
      if (p && typeof p === 'object' && 'x' in p && 'y' in p) {
        const { x, y } = p
        if (typeof x === 'number' && typeof y === 'number') return { x, y }
      }
      return { x: 0, y: 0 }
    },
  }
}

function intersects(a: Segment, b: Segment): boolean {
  const denom = (a.x1 - a.x2) * (b.y1 - b.y2) - (a.y1 - a.y2) * (b.x1 - b.x2)
  if (denom === 0) return false
  const xNum =
    (a.x1 * a.y2 - a.y1 * a.x2) * (b.x1 - b.x2) - (a.x1 - a.x2) * (b.x1 * b.y2 - b.y1 * b.x2)
  const yNum =
    (a.x1 * a.y2 - a.y1 * a.x2) * (b.y1 - b.y2) - (a.y1 - a.y2) * (b.x1 * b.y2 - b.y1 * b.x2)
  const x = xNum / denom
  const y = yNum / denom
  const between = (v: number, b1: number, b2: number): boolean =>
    (v >= b1 && v <= b2) || (v >= b2 && v <= b1)
  return (
    between(x, a.x1, a.x2) &&
    between(y, a.y1, a.y2) &&
    between(x, b.x1, b.x2) &&
    between(y, b.y1, b.y2)
  )
}

/**
 * Whole-stroke eraser: every drawn element is sampled into short segments
 * when the tool is selected, and a drag that crosses a segment removes the
 * element it belongs to. Undo restores the batch erased in one drag.
 */
export class EraserModel extends BaseModel<SVGRectElement> {
  pathSubFactor = 20
  private fragments: PathFragment[] = []
  private previous: Point | null = null
  private erased: Element[] = []

  override onSelected(el: SVGSVGElement | null): void {
    this.fragments = []
    if (el) this.collect(el.children, undefined)
  }

  private collect(children: HTMLCollection, owner: Element | undefined): void {
    for (const child of Array.from(children)) {
      // instanceof SVGElement is unavailable under happy-dom; the namespace is enough.
      if (child.namespaceURI !== SVG_NS) continue
      const m = measurable(child)
      if (m) {
        const length = m.getTotalLength()
        for (let j = 0; j < this.pathSubFactor; j++) {
          const a = m.getPointAtLength((length * j) / this.pathSubFactor)
          const b = m.getPointAtLength((length * (j + 1)) / this.pathSubFactor)
          this.fragments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, element: owner ?? child })
        }
      } else {
        this.collect(child.children, owner ?? child)
      }
    }
  }

  override onUnselected(): void {
    this.fragments = []
  }

  override onStart(point: Point): SVGElement | undefined {
    this.previous = point
    return undefined
  }

  override onMove(point: Point): boolean {
    const previous = this.previous
    this.previous = point
    if (!previous) return false
    const stroke: Segment = { x1: previous.x, y1: previous.y, x2: point.x, y2: point.y }
    let hit = false
    for (const fragment of this.fragments) {
      if (this.erased.includes(fragment.element)) continue
      if (intersects(fragment, stroke)) {
        this.drauu._removeNode(fragment.element)
        this.erased.push(fragment.element)
        hit = true
      }
    }
    if (hit) this.fragments = this.fragments.filter((f) => !this.erased.includes(f.element))
    return hit
  }

  override onEnd(): Operation {
    this.previous = null
    const erased = this.erased
    this.erased = []
    return {
      undo: (): void => {
        for (const node of erased) this.drauu._restoreNode(node)
      },
      redo: (): void => {
        for (const node of erased) this.drauu._removeNode(node)
      },
    }
  }
}
