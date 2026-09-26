/**
 * Default text colour for canvas artefacts that let Copse supply their surface.
 *
 * A transparent inline-HTML artefact shows the host's `--bg-base` through its
 * root (the Browser pane's webview host, and the agent mirror's window
 * background). Host CSS does not inherit into a guest document, though, so the
 * artefact's text stays Chromium's default black — unreadable on the dark
 * surface. Both surfaces inject the host's text colour into the guest, but only
 * when the guest's roots are transparent: an artefact that paints its own
 * background keeps the browser defaults it was written against.
 *
 * Shared so the live webview and the headless mirror make the same decision and
 * their screenshots stay evidence about the same pixels. Free of Electron and
 * DOM imports so it runs in main, the renderer, and the unit-test runner.
 */

/**
 * Guest-side probe (a script expression): true when neither the root element
 * nor `<body>` paints a colour or an image, i.e. the host surface shows through.
 */
export const CANVAS_TRANSPARENT_ROOT_PROBE = `(() => {
  const paints = (element) => {
    if (!element) return false
    const style = getComputedStyle(element)
    if (style.backgroundImage !== 'none') return true
    const alpha = /^rgba\\((?:[^,]+,){3}\\s*([\\d.]+)\\s*\\)$/.exec(style.backgroundColor)
    return alpha ? Number(alpha[1]) > 0 : style.backgroundColor !== 'transparent'
  }
  return !paints(document.documentElement) && !paints(document.body)
})()`

/** Computed `rgb()`/`rgba()` colours only: the value is spliced into CSS. */
const COMPUTED_COLOR_RE = /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)$/

/**
 * The stylesheet injected into a transparent artefact: the host's text colour
 * at zero specificity, so any colour the artefact declares still wins. Returns
 * null for anything that is not a computed colour.
 */
export function canvasGuestTextCss(color: string): string | null {
  if (!COMPUTED_COLOR_RE.test(color.trim())) return null
  return `:where(:root) { color: ${color.trim()}; }`
}
