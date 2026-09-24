import type { Point } from '../types.ts'
import { numSort, splitNum, totalLength } from '../utils.ts'
import { BaseModel } from './base.ts'

/** Rectangle; shift constrains to a square, alt grows from the centre. */
export class RectModel extends BaseModel<SVGRectElement> {
  override onStart(point: Point): SVGElement | undefined {
    this.el = this.createElement('rect')
    if (this.brush.cornerRadius) {
      this.attr('rx', this.brush.cornerRadius)
      this.attr('ry', this.brush.cornerRadius)
    }
    this.attr('x', point.x)
    this.attr('y', point.y)
    return this.el
  }

  override onMove(point: Point): boolean {
    if (!this.el || !this.start) return false
    const [ax, sx] = splitNum(point.x - this.start.x)
    const [ay, sy] = splitNum(point.y - this.start.y)
    const dx = this.shiftPressed ? Math.min(ax, ay) : ax
    const dy = this.shiftPressed ? Math.min(ax, ay) : ay

    if (this.altPressed) {
      this.attr('x', this.start.x - dx)
      this.attr('y', this.start.y - dy)
      this.attr('width', dx * 2)
      this.attr('height', dy * 2)
    } else {
      const [x1 = 0, x2 = 0] = [this.start.x, this.start.x + dx * sx].sort(numSort)
      const [y1 = 0, y2 = 0] = [this.start.y, this.start.y + dy * sy].sort(numSort)
      this.attr('x', x1)
      this.attr('y', y1)
      this.attr('width', x2 - x1)
      this.attr('height', y2 - y1)
    }
    return true
  }

  override onEnd(): boolean {
    const rect = this.el
    this.el = null
    if (!rect) return false
    const length = totalLength(rect)
    return length === null || length > 0
  }
}
