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
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.min(value, MAX_SCROLL_OFFSET)
}

/**
 * Validate the guest's answer. Anything that is not a pair of finite,
 * non-negative offsets (a cross-origin failure, a hostile page, an older
 * guest) is treated as "no scroll" rather than a parse error so the overlay
 * simply falls back to viewport anchoring.
 */
export function parseGuestScrollPosition(value: unknown): GuestScrollPosition {
  if (value && typeof value === 'object' && 'x' in value && 'y' in value) {
    const { x, y } = value
    const cx = clampOffset(x)
    const cy = clampOffset(y)
    if (cx !== null && cy !== null) return { x: cx, y: cy }
  }
  return { x: 0, y: 0 }
}
