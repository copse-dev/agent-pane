/**
 * Pin `value` into `[min, max]`: `Math.min(max, Math.max(min, value))`.
 *
 * When `max < min` the upper bound wins and the result is `max`. A caller that
 * needs the lower bound to win instead (a tooltip wider than the viewport keeps
 * its leading edge on screen) should keep its own helper rather than change
 * this one. `NaN` in `value` comes back as `NaN`.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
