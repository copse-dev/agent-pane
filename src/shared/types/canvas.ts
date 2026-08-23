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
  /** Thread that rendered this artefact; scopes tabs and previews with common titles. */
  threadId?: string
  /**
   * A small PNG `data:` URL of the rendered artefact, captured from the agent
   * browser session. Absent when the canvas could not be mirrored (no Electron
   * platform, tab limit reached, capture failed) — every consumer must treat a
   * missing preview as normal and simply show no thumbnail.
   */
  preview?: string
}

/** Identity used when promoting a rendered artefact into the visible pane. */
export interface CanvasArtefactIdentity {
  title: string
  threadId?: string
}
