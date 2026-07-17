/**
 * Pure planner for the portrait panel-controls row: how many trailing buttons
 * should move into the `…` menu so the remaining buttons + overflow trigger fit.
 *
 * `widths` are left-to-right eligible (visible, non-experimental-hidden) button
 * widths. `gap` is the flex gap between items. Returns the number of trailing
 * buttons to hide (0 when everything fits without the overflow trigger).
 */
export function countPortraitPanelOverflow(
  widths: readonly number[],
  gap: number,
  containerWidth: number,
  overflowTriggerWidth: number,
  minVisible = 1,
): number {
  if (widths.length === 0) return 0
  const rowWidth = (count: number, includeOverflow: boolean): number => {
    if (count <= 0) return includeOverflow ? overflowTriggerWidth : 0
    let total = 0
    for (let i = 0; i < count; i++) {
      total += widths[i] ?? 0
      if (i > 0) total += gap
    }
    if (includeOverflow) total += gap + overflowTriggerWidth
    return total
  }

  if (rowWidth(widths.length, false) <= containerWidth) return 0

  const maxHide = Math.max(0, widths.length - minVisible)
  for (let hide = 1; hide <= maxHide; hide++) {
    if (rowWidth(widths.length - hide, true) <= containerWidth) return hide
  }
  return maxHide
}
