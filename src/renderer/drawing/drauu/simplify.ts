/*
 (c) 2017, Vladimir Agafonkin
 Simplify.js, a high-performance JS polyline simplification library
 mourner.github.io/simplify-js
*/
import type { Point } from './types.ts'

function getSqDist(p1: Point, p2: Point): number {
  const dx = p1.x - p2.x
  const dy = p1.y - p2.y
  return dx * dx + dy * dy
}

/** Square distance from a point to a segment. */
function getSqSegDist(p: Point, p1: Point, p2: Point): number {
  let x = p1.x
  let y = p1.y
  let dx = p2.x - x
  let dy = p2.y - y

  if (dx !== 0 || dy !== 0) {
    const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy)
    if (t > 1) {
      x = p2.x
      y = p2.y
    } else if (t > 0) {
      x += dx * t
      y += dy * t
    }
  }

  dx = p.x - x
  dy = p.y - y
  return dx * dx + dy * dy
}

function simplifyRadialDist(points: Point[], sqTolerance: number): Point[] {
  const first = points[0]
  if (!first) return []
  let prevPoint = first
  const newPoints = [prevPoint]
  let point: Point | undefined

  for (let i = 1, len = points.length; i < len; i++) {
    point = points[i]
    if (point && getSqDist(point, prevPoint) > sqTolerance) {
      newPoints.push(point)
      prevPoint = point
    }
  }

  if (point && prevPoint !== point) newPoints.push(point)
  return newPoints
}

function simplifyDPStep(
  points: Point[],
  first: number,
  last: number,
  sqTolerance: number,
  simplified: Point[],
): void {
  let maxSqDist = sqTolerance
  let index = 0
  const a = points[first]
  const b = points[last]
  if (!a || !b) return

  for (let i = first + 1; i < last; i++) {
    const p = points[i]
    if (!p) continue
    const sqDist = getSqSegDist(p, a, b)
    if (sqDist > maxSqDist) {
      index = i
      maxSqDist = sqDist
    }
  }

  if (maxSqDist > sqTolerance) {
    if (index - first > 1) simplifyDPStep(points, first, index, sqTolerance, simplified)
    const mid = points[index]
    if (mid) simplified.push(mid)
    if (last - index > 1) simplifyDPStep(points, index, last, sqTolerance, simplified)
  }
}

/** Ramer-Douglas-Peucker simplification. */
function simplifyDouglasPeucker(points: Point[], sqTolerance: number): Point[] {
  const last = points.length - 1
  const first = points[0]
  const end = points[last]
  if (!first || !end) return points
  const simplified = [first]
  simplifyDPStep(points, 0, last, sqTolerance, simplified)
  simplified.push(end)
  return simplified
}

/** Both algorithms combined; `highestQuality` skips the radial pre-pass. */
export function simplify(points: Point[], tolerance: number, highestQuality = false): Point[] {
  if (points.length <= 2) return points
  const sqTolerance = tolerance * tolerance
  const reduced = highestQuality ? points : simplifyRadialDist(points, sqTolerance)
  return simplifyDouglasPeucker(reduced, sqTolerance)
}
