const SVG_NS = 'http://www.w3.org/2000/svg'
const ICON_SIZE = '16'

// Shared builder for the app's lucide-style outline icons: a 24×24 viewBox with
// `currentColor` strokes (weight/caps come from the caller's CSS class). Both the
// titlebar controls and the composer's attach button render through this so the
// iconography stays consistent.
export function outlineIcon(label: string, paths: string[], className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', ICON_SIZE)
  svg.setAttribute('height', ICON_SIZE)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('data-icon', label)
  // Presentation-attribute fallbacks mirroring the callers' CSS. CSS always
  // wins over presentation attributes, so these are inert under Chromium —
  // but engines that rasterize inline SVG from a serialized copy (Servo)
  // lose stylesheet context, and without these the icons render as solid
  // fill-black shapes. See docs/plans/tauri-servo-migration.md.
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.75')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')

  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }

  return svg
}
