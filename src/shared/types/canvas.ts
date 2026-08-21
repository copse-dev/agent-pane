/**
 * A renderable artefact produced by an MCP-UI resource (the "canvas").
 * Currently only self-contained HTML (`text/html`) is rendered; the type carries
 * the mime so future kinds (e.g. `text/uri-list`) can branch on it.
 */
export interface CanvasArtefact {
  /** Friendly title shown on the canvas tab (falls back to the resource URI). */
  title: string
  mimeType: string
  /** The artefact body: an HTML document, or a URL for `text/uri-list`. */
  body: string
  /**
   * A small PNG `data:` URL of the rendered artefact, captured from the agent
   * browser session. Absent when the canvas could not be mirrored (no Electron
   * platform, tab limit reached, capture failed) — every consumer must treat a
   * missing preview as normal and simply show no thumbnail.
   */
  preview?: string
}
