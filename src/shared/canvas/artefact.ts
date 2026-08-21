/**
 * Canvas artefact identity and addressing.
 *
 * Shared because two very different consumers must agree byte-for-byte on it:
 * the Browser pane's `<webview>` (what the user sees) and the headless agent
 * browser session (what `browser_screenshot` / `browser_snapshot` see). If they
 * derived the URL separately the agent could screenshot a different document
 * from the one on screen — the failure this module exists to prevent.
 *
 * Kept free of Electron and DOM imports so it runs in the main process, the
 * renderer, and the unit-test runner alike.
 */
import { normalizeBrowserUrl } from '../browser-url.ts'
import type { CanvasArtefact } from '../types/canvas.ts'

/** Encode an HTML document as a base64 `data:` URL (opaque origin, no network). */
export function htmlDataUrl(html: string): string {
  const bytes = new TextEncoder().encode(html)
  let binary = ''
  // Chunked so a large document cannot blow the argument limit of `apply`.
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return `data:text/html;charset=utf-8;base64,${btoa(binary)}`
}

/**
 * The URL that renders `artefact`: an opaque `data:` URL for inline HTML, or a
 * normalized target for a URL-list artefact (still subject to the browser
 * origin policy when the agent session loads it).
 */
export function artefactUrl(artefact: CanvasArtefact): string {
  return artefact.mimeType === 'text/html'
    ? htmlDataUrl(artefact.body)
    : normalizeBrowserUrl(artefact.body)
}

/**
 * Derive a friendly tab title from a `ui://server/<name>` resource URI.
 *
 * Shared because the title is the artefact's identity everywhere: the Browser
 * pane keys its tabs on it, the agent mirror keys its tabs on it, and the
 * transcript's preview card recovers it from the `ui://` URI in the tool result
 * to find the matching thumbnail. All three must agree on the same string.
 */
export function artefactTitleFromUri(uri: string): string {
  // Drop the scheme (e.g. `ui://`) so the title comes from the path segments.
  const path = uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const tail = path.split('/').filter(Boolean).pop()
  if (!tail) return 'Artefact'
  return tail.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
