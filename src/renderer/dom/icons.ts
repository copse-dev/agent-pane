import { outlineIcon } from './outline-icon.ts'

// Named lucide-style icons for product-UI chrome. Historically these were
// Unicode glyphs (▶ ✕ ↻ 🔍 …) rendered as text, but several codepoints get
// promoted to colour-emoji presentation by the OS font stack — so a collapsed
// file-tree twisty showed up as an orange ▶️ on some platforms while the
// expanded ▼ stayed grey. Rendering them as `currentColor` SVGs makes the
// iconography consistent across platforms and themeable via CSS.
//
// Every factory takes the class applied to the <svg>; default `ui-icon` carries
// the stroke styling (see styles/global/icons.css). Pass a size modifier
// (`ui-icon ui-icon-sm`) or a bespoke class when a call site needs it.

const DEFAULT = 'ui-icon'

export function chevronRightIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon('chevron-right', ['m9 18 6-6-6-6'], className)
}

export function chevronDownIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon('chevron-down', ['m6 9 6 6 6-6'], className)
}

export function arrowLeftIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon('arrow-left', ['M19 12H5', 'm12 19-7-7 7-7'], className)
}

export function arrowRightIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon('arrow-right', ['M5 12h14', 'm12 5 7 7-7 7'], className)
}

export function arrowDownIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon('arrow-down', ['M12 5v14', 'm19 12-7 7-7-7'], className)
}

export function refreshIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon(
    'refresh',
    [
      'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8',
      'M21 3v5h-5',
      'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16',
      'M8 16H3v5',
    ],
    className,
  )
}

export function externalLinkIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon(
    'external-link',
    ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
    className,
  )
}

export function closeIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon('close', ['M18 6 6 18', 'm6 6 12 12'], className)
}

/** Three horizontal dots (overflow / "more"). Relies on round line caps. */
export function moreHorizontalIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon('more-horizontal', ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'], className)
}

export function checkIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon('check', ['M20 6 9 17l-5-5'], className)
}

/** Open (hollow) circle — a "pending / not started" status marker. */
export function circleIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon('circle', ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z'], className)
}

export function searchIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon(
    'search',
    ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'm21 21-4.35-4.35'],
    className,
  )
}
