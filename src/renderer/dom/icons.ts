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

export function chevronUpIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon('chevron-up', ['m18 15-6-6-6 6'], className)
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

export function plusIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon('plus', ['M5 12h14', 'M12 5v14'], className)
}

export function downloadIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon(
    'download',
    ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
    className,
  )
}

export function uploadIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon(
    'upload',
    ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm17 8-5-5-5 5', 'M12 3v12'],
    className,
  )
}

/** Arrows pushing into opposite corners — expand a pane to fill its window. */
export function maximizeIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon('maximize', ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'], className)
}

/** The same arrows pulled back inward — restore an expanded pane. */
export function minimizeIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon('minimize', ['M4 14h6v6', 'M20 10h-6V4', 'M14 10l7-7', 'M3 21l7-7'], className)
}

/** Three horizontal dots (overflow / "more"). Relies on round line caps. */
export function moreHorizontalIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon('more-horizontal', ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'], className)
}

/**
 * Same three-dot glyph as {@link moreHorizontalIcon}, used as a running-thread
 * status mark. CSS animates opacity across the paths so the ellipsis "walks".
 */
export function runningStatusIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon('running-status', ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'], className)
}

export function checkIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon('check', ['M20 6 9 17l-5-5'], className)
}

/** Filled dot for "saved / connected" inline statuses. */
export function dotIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon('dot', ['M12 12h.01'], `${className} ui-icon-dot`)
}

/** Open (hollow) circle — a "pending / in progress" status marker (CSS may spin it). */
export function circleIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon('circle', ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z'], className)
}

/** Horizontal minus — a settled "absent / not loaded" marker (not in-progress). */
export function minusIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon('minus', ['M5 12h14'], className)
}

export function warningIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon(
    'triangle-alert',
    [
      'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z',
      'M12 9v4',
      'M12 17h.01',
    ],
    className,
  )
}

export function searchIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon(
    'search',
    ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'm21 21-4.35-4.35'],
    className,
  )
}

export function fileTextIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon(
    'file-text',
    [
      'M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z',
      'M14 2v6h6',
      'M8 13h8',
      'M8 17h8',
    ],
    className,
  )
}

export function imageIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon(
    'image',
    [
      'M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8.3',
      'm21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21',
      'M14 19.5 16.5 17a2 2 0 0 1 2.8 0l1.7 1.7',
      'M9 9h.01',
    ],
    className,
  )
}

/** Lightning/zap — marks the hook-card family (a hook fired / triggered). */
export function zapIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon(
    'zap',
    [
      'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z',
    ],
    className,
  )
}

/** Lucide git-pull-request — sidebar thread GitHub PR status mark. */
export function gitPullRequestIcon(className = DEFAULT): SVGSVGElement {
  return outlineIcon(
    'git-pull-request',
    [
      'M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
      'M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
      'M13 6h3a2 2 0 0 1 2 2v7',
      'M6 9v12',
    ],
    className,
  )
}
