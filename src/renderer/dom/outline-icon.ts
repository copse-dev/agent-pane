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

  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }

  return svg
}
