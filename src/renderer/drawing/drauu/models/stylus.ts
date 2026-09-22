import { getStroke } from 'perfect-freehand'
import type { Brush, Point } from '../types.ts'
import { SVG_NS } from '../utils.ts'
import { BaseModel } from './base.ts'

/** Pressure-sensitive pen: perfect-freehand outline committed as a filled path. */
export class StylusModel extends BaseModel<SVGPathElement> {
  points: Point[] = []

  override onStart(point: Point): SVGElement | undefined {
    this.el = document.createElementNS(SVG_NS, 'path')
    this.points = [point]
    this.attr('fill', this.brush.color)
    this.attr('d', this.getSvgData(this.points))
    return this.el
  }

  override onMove(point: Point): boolean {
    if (!this.el) this.onStart(point)
    if (this.points.at(-1) !== point) this.points.push(point)
    this.attr('d', this.getSvgData(this.points))
    return true
  }

  override onEnd(): boolean {
    const path = this.el
    this.el = null
    return path !== null
  }

  getSvgData(points: Point[]): string {
    return StylusModel.getSvgData(points, this.brush)
  }

  static getSvgData(points: Point[], brush: Brush): string {
    const stroke = getStroke(points, {
      size: brush.size,
      thinning: 0.9,
      simulatePressure: false,
      start: { taper: 5 },
      end: { taper: 5 },
      ...brush.stylusOptions,
    })
    const first = stroke[0]
    if (!first) return ''

    const parts: string[] = [`M ${first[0].toFixed(2)} ${first[1].toFixed(2)} Q`]
    for (let i = 0; i < stroke.length; i++) {
      const a = stroke[i]
      const b = stroke[(i + 1) % stroke.length]
      if (!a || !b) continue
      const [x0, y0] = a
      const [x1, y1] = b
      parts.push(
        x0.toFixed(2),
        y0.toFixed(2),
        ((x0 + x1) / 2).toFixed(2),
        ((y0 + y1) / 2).toFixed(2),
      )
    }
    parts.push('Z')
    return parts.join(' ')
  }
}
