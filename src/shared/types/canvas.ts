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
  /**
   * Workspace-relative path of the file the artefact was rendered from, when it
   * came from one (`render_html_artefact`'s preferred `path` argument). Absent
   * for inline HTML and for external MCP servers, which have no such file.
   *
   * Provenance, and the reason a restored artefact can show later edits: when
   * the canvas store reopens a saved artefact it prefers this file over its own
   * snapshot, so editing the HTML and reopening shows the edit.
   */
  sourcePath?: string
}

/** Identity used when promoting a rendered artefact into the visible pane. */
export interface CanvasArtefactIdentity {
  title: string
  threadId?: string
}

/**
 * A saved artefact as the transcript needs it: enough to draw the preview card
 * that offers to reopen it, without reading the (much larger) body back.
 */
export interface CanvasArtefactSummary {
  title: string
  preview?: string
}
