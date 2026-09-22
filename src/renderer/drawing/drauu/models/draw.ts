import type { Point } from '../types.ts'
import { D, createArrowHead, guid, totalLength } from '../utils.ts'
import { simplify } from '../simplify.ts'
import { BaseModel } from './base.ts'

/** Plain polyline pen smoothed with cubic Béziers; no pressure. */
export class DrawModel extends BaseModel<SVGPathElement> {
  points: Point[] = []
  private count = 0

  override onStart(point: Point): SVGElement | undefined {
    this.el = this.createElement('path', { fill: 'transparent' })
    this.points = [point]

    if (this.brush.arrowEnd) {
      const id = guid()
      this.el.appendChild(createArrowHead(id, this.brush.color))
      this.el.setAttribute('marker-end', `url(#${id})`)
    }
    return this.el
  }

  override onMove(point: Point): boolean {
    if (!this.el) this.onStart(point)

    if (this.points.at(-1) !== point) {
      this.points.push(point)
      this.count += 1
    }

    // Re-simplify periodically so a long stroke does not grow without bound.
    if (this.count > 5) {
      this.points = simplify(this.points, 1, true)
      this.count = 0
    }

    this.attr('d', DrawModel.toSvgData(this.points))
    return true
  }

  override onEnd(): boolean {
    const path = this.el
    this.el = null
    if (!path) return false

    path.setAttribute('d', DrawModel.toSvgData(simplify(this.points, 1, true)))

    const first = this.points[0]
    if (totalLength(path) === 0 && first) {
      // A click without movement: draw a dot.
      const r = (this.brush.size / 2).toFixed(D)
      const d2 = this.brush.size.toFixed(D)
      const x = (first.x - this.brush.size / 2).toFixed(D)
      const y = first.y.toFixed(D)
      path.setAttribute('d', `M ${x} ${y} a ${r},${r} 0 1,0 ${d2},0 a ${r},${r} 0 1,0 -${d2},0`)
      path.setAttribute('fill', this.brush.color)
      path.setAttribute('stroke-width', '0')
    }
    return true
  }

  // https://francoisromain.medium.com/smooth-a-svg-path-with-cubic-bezier-curves-e37b49d46c74
  static line(a: Point, b: Point): { length: number; angle: number } {
    const lengthX = b.x - a.x
    const lengthY = b.y - a.y
    return { length: Math.sqrt(lengthX ** 2 + lengthY ** 2), angle: Math.atan2(lengthY, lengthX) }
  }

  static controlPoint(current: Point, previous?: Point, next?: Point, reverse?: boolean): Point {
    const p = previous ?? current
    const n = next ?? current
    const smoothing = 0.2
    const o = DrawModel.line(p, n)
    const angle = o.angle + (reverse ? Math.PI : 0)
    const length = o.length * smoothing
    return { x: current.x + Math.cos(angle) * length, y: current.y + Math.sin(angle) * length }
  }

  static bezierCommand(point: Point, i: number, points: Point[]): string {
    const prev = points[i - 1] ?? point
    const cps = DrawModel.controlPoint(prev, points[i - 2], point)
    const cpe = DrawModel.controlPoint(point, prev, points[i + 1], true)
    return `C ${cps.x.toFixed(D)},${cps.y.toFixed(D)} ${cpe.x.toFixed(D)},${cpe.y.toFixed(D)} ${point.x.toFixed(D)},${point.y.toFixed(D)}`
  }

  static toSvgData(points: Point[]): string {
    return points.reduce(
      (acc, point, i, a) =>
        i === 0
          ? `M ${point.x.toFixed(D)},${point.y.toFixed(D)}`
          : `${acc} ${DrawModel.bezierCommand(point, i, a)}`,
      '',
    )
  }
}
