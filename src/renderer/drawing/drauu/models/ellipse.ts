import type { Point } from '../types.ts'
import { numSort, splitNum, totalLength } from '../utils.ts'
import { BaseModel } from './base.ts'

/** Ellipse; shift constrains to a circle, alt grows from the centre. */
export class EllipseModel extends BaseModel<SVGEllipseElement> {
  override onStart(point: Point): SVGElement | undefined {
    this.el = this.createElement('ellipse')
    this.attr('cx', point.x)
    this.attr('cy', point.y)
    return this.el
  }

  override onMove(point: Point): boolean {
    if (!this.el || !this.start) return false
    const [ax, sx] = splitNum(point.x - this.start.x)
    const [ay, sy] = splitNum(point.y - this.start.y)
    const dx = this.shiftPressed ? Math.min(ax, ay) : ax
    const dy = this.shiftPressed ? Math.min(ax, ay) : ay

    if (this.altPressed) {
      this.attr('cx', this.start.x)
      this.attr('cy', this.start.y)
      this.attr('rx', dx)
      this.attr('ry', dy)
    } else {
      const [x1 = 0, x2 = 0] = [this.start.x, this.start.x + dx * sx].sort(numSort)
      const [y1 = 0, y2 = 0] = [this.start.y, this.start.y + dy * sy].sort(numSort)
      this.attr('cx', (x1 + x2) / 2)
      this.attr('cy', (y1 + y2) / 2)
      this.attr('rx', (x2 - x1) / 2)
      this.attr('ry', (y2 - y1) / 2)
    }
    return true
  }

  override onEnd(): boolean {
    const ellipse = this.el
    this.el = null
    if (!ellipse) return false
    const length = totalLength(ellipse)
    return length === null || length > 0
  }
}
