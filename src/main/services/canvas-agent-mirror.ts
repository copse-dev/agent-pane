/**
 * Mirror canvas artefacts into the headless agent browser session.
 *
 * Without this the canvas is write-only to the model: `render_html_artefact`
 * pushes a document to the Browser pane, and `browser_snapshot` /
 * `browser_screenshot` — which only ever see the agent session — cannot read it
 * back. The agent would be iterating on a prototype it is unable to look at.
 *
 * Loading the same URL into an agent tab closes that loop, and is why
 * `artefactUrl` is shared: both surfaces render byte-identical documents, so a
 * screenshot is evidence about what the user sees rather than a near-miss.
 *
 * The mirror is best-effort by construction. A failure here means the agent
 * cannot inspect the artefact; it must never stop the artefact reaching the
 * user's canvas, so every path resolves rather than throws.
 *
 * Electron types are injected, so this runs under the unit-test runner.
 */
import type { CanvasArtefact } from '@shared/types/canvas.ts'
import { artefactUrl } from '@shared/canvas/artefact.ts'

export interface CanvasMirrorSession {
  navigate(
    url: string,
    opts?: { newTab?: boolean | undefined; viewId?: string | undefined },
  ): Promise<{ viewId: string }>
  /** A small PNG `data:` URL of the tab, or null when capture is unavailable. */
  capturePreview(viewId: string): Promise<string | null>
}

/**
 * Artefact title -> agent tab. Titles are the artefact's identity on the canvas
 * (see `artefactTabFor` in the Browser pane), so re-rendering reuses the tab on
 * both sides and the agent's `viewId` stays stable across versions.
 */
const viewIdByArtefact = new Map<string, string>()

/** Stable collision-free key for a title within one thread. */
function artefactKey(threadId: string | undefined, title: string): string {
  return JSON.stringify([threadId ?? '', title])
}

/** @internal test helper — drop the thread-and-title→tab mapping. */
export function resetCanvasAgentMirrorForTest(): void {
  viewIdByArtefact.clear()
}

/**
 * Load `artefact` into the agent session and return a preview PNG data URL.
 *
 * Returns null when the artefact could not be mirrored or captured — callers
 * treat that as "no thumbnail", never as an error.
 */
export async function mirrorArtefactToAgent(
  artefact: CanvasArtefact,
  session: CanvasMirrorSession,
): Promise<string | null> {
  // `text/uri-list` is supplied by an MCP server and may name any external
  // origin. Navigating it here would bypass the approval that guards
  // `browser_navigate`, merely because a tool returned a canvas resource.
  // Self-contained HTML becomes an opaque data: document and is safe to mirror
  // automatically; external artefacts remain visible in the canvas only.
  if (artefact.mimeType !== 'text/html') return null
  const url = artefactUrl(artefact)
  const key = artefactKey(artefact.threadId, artefact.title)
  const known = viewIdByArtefact.get(key)

  let viewId: string
  try {
    viewId = (await session.navigate(url, known ? { viewId: known } : { newTab: true })).viewId
  } catch {
    // The remembered tab is gone — the agent closed it via `browser_tabs`, or
    // the session was torn down. Forget it and try once more in a fresh tab.
    // Without this a single closed tab would wedge the mirror for that title
    // for the rest of the session.
    if (!known) return null
    viewIdByArtefact.delete(key)
    try {
      viewId = (await session.navigate(url, { newTab: true })).viewId
    } catch {
      return null
    }
  }

  viewIdByArtefact.set(key, viewId)
  try {
    return await session.capturePreview(viewId)
  } catch {
    return null
  }
}
