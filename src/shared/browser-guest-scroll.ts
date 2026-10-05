/**
 * Scroll position of a browser guest page, read from inside the guest. The
 * annotation overlay is page-anchored, so the embedder needs the guest's
 * scroll offsets to keep marks glued to the content they were drawn on.
 */
export interface GuestScrollPosition {
  x: number
  y: number
}

const MAX_SCROLL_OFFSET = 1_000_000

/**
 * Read the main frame's scroll position inside the guest. The script runs
 * through `webContents.executeJavaScript`, which returns the evaluated value
 * itself — no round-trip protocol needed.
 */
export const GUEST_SCROLL_SCRIPT = `(${String((): GuestScrollPosition => {
  const doc = document.documentElement
  return { x: window.scrollX || doc.scrollLeft, y: window.scrollY || doc.scrollTop }
})})()`

function clampOffset(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  // Negative offsets are real: a right-to-left page scrolled horizontally
  // reports a negative scrollX, and elastic overscroll a briefly negative Y.
  return Math.min(Math.max(value, -MAX_SCROLL_OFFSET), MAX_SCROLL_OFFSET)
}

/**
 * Validate the guest's answer. Anything that is not a pair of finite offsets
 * (a cross-origin failure, a hostile page, an older guest) is null — "no
 * answer" — so the overlay keeps the last position it knew instead of
 * snapping every mark to the page origin.
 */
export function parseGuestScrollPosition(value: unknown): GuestScrollPosition | null {
  if (typeof value !== 'object' || value === null) return null
  const cx = clampOffset(Reflect.get(value, 'x'))
  const cy = clampOffset(Reflect.get(value, 'y'))
  return cx !== null && cy !== null ? { x: cx, y: cy } : null
}
