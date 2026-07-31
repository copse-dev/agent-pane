const SVG_NS = 'http://www.w3.org/2000/svg'

// The spiral silhouette is animated with CSS so it can inherit the current
// theme and respect reduced motion.
const SPIRAL_PATH =
  'M416.134 -141.959 C384 -475 -72 -488 -286.485 -266.216 C-474.71 -71.585 -423.084 227.135 -226.856 360.464 C5 518 328 385 297.052 111.165 C273.531 -96.947 -15 -98 -62.629 47.319 C-128.956 249.689 154 322 180.928 153.093'

export function reasoningActivityIcon(className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('viewBox', '-540 -540 1080 1080')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('data-icon', 'reasoning-activity')

  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('class', 'reasoning-activity-path')
  path.setAttribute('d', SPIRAL_PATH)
  path.setAttribute('pathLength', '1')
  svg.append(path)

  return svg
}
