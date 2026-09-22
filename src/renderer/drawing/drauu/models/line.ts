import type { Point } from '../types.ts'
import { SVG_NS, createArrowHead, guid, totalLength } from '../utils.ts'
import { BaseModel } from './base.ts'

/** Straight line; shift snaps the angle, alt mirrors around the start point. */
export class LineModel extends BaseModel<SVGLineElement> {
  override onStart(point: Point): SVGElement | undefined {
    this.el = this.createElement('line', { fill: 'transparent' })
    this.attr('x1', point.x)
    this.attr('y1', point.y)
    this.attr('x2', point.x)
    this.attr('y2', point.y)

    if (this.brush.arrowEnd) {
      const id = guid()
      const g = document.createElementNS(SVG_NS, 'g')
      g.append(createArrowHead(id, this.brush.color))
      g.append(this.el)
      this.attr('marker-end', `url(#${id})`)
      return g
    }
    return this.el
  }

  override onMove(point: Point): boolean {
    if (!this.el || !this.start) return false
    let { x, y } = point

    if (this.shiftPressed) {
      const dx = point.x - this.start.x
      const dy = point.y - this.start.y
      if (dy !== 0) {
        const slope = Math.round(dx / dy)
        if (Math.abs(slope) <= 1) {
          x = this.start.x + dy * slope
          y = this.start.y + dy
        } else {
          x = this.start.x + dx
          y = this.start.y
        }
      }
    }

    if (this.altPressed) {
      this.attr('x1', this.start.x * 2 - x)
      this.attr('y1', this.start.y * 2 - y)
    } else {
      this.attr('x1', this.start.x)
      this.attr('y1', this.start.y)
    }
    this.attr('x2', x)
    this.attr('y2', y)
    return true
  }

  override onEnd(): boolean {
    const line = this.el
    this.el = null
    if (!line) return false
    const length = totalLength(line)
    // Where the DOM cannot measure (jsdom) keep the line; else drop accidental taps.
    return length === null || length >= 5
  }
}
