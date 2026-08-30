/**
 * Thumbnails for canvas artefacts, and the promote hook the transcript uses.
 *
 * A re-rendered artefact refreshes its Browser-pane tab in the background, so
 * the transcript is where the user finds out a new version exists. The preview
 * card there shows what was rendered and offers to bring it forward — the "then
 * once it's happy it could trigger an open" half of render-then-show, driven by
 * the user rather than the agent.
 *
 * A module-level registry rather than store state: tool cards are built deep
 * inside the conversation renderer without an `AppStore` in scope, and threading
 * one through every card constructor to reach two lookups would be a worse
 * trade than this seam.
 */

import type { ApiClient } from '../../preload/api.d.ts'

/** Thread + artefact title -> PNG `data:` URL captured from the agent browser session. */
const previews = new Map<string, string>()

let showHandler: ((threadId: string, title: string) => void) | null = null

function previewKey(threadId: string, title: string): string {
  return JSON.stringify([threadId, title])
}

/**
 * Remember the newest thumbnail for `title`. Later versions overwrite earlier
 * ones deliberately: the tab shows the newest render, so the card must too, and
 * keeping a history would pin every version's bitmap in memory for the session.
 */
export function setArtefactPreview(
  threadId: string,
  title: string,
  preview: string | undefined,
): void {
  if (preview) previews.set(previewKey(threadId, title), preview)
}

export function getArtefactPreview(threadId: string, title: string): string | undefined {
  return previews.get(previewKey(threadId, title))
}

/**
 * Fill the registry from the artefacts this thread saved on disk, so cards for
 * renders from an earlier session draw with their thumbnail instead of being
 * skipped — `createCanvasPreviewSection` shows nothing without one, which is
 * why closing the app used to take the whole card with it.
 *
 * Resolves to true when it added anything, so the caller knows whether a
 * repaint is worth scheduling. Best-effort: a thread that never rendered an
 * artefact, or a store that cannot be read, simply leaves the registry alone.
 */
export async function hydrateArtefactPreviews(
  api: ApiClient,
  projectId: string,
  threadId: string,
): Promise<boolean> {
  const saved = await api.canvas.listArtefacts(projectId, threadId).catch(() => [])
  let added = false
  for (const artefact of saved) {
    if (!artefact.preview) continue
    setArtefactPreview(threadId, artefact.title, artefact.preview)
    added = true
  }
  return added
}

/** Wire the Open button to the Browser pane (see `showCanvasArtefact`). */
export function setArtefactShowHandler(
  handler: ((threadId: string, title: string) => void) | null,
): void {
  showHandler = handler
}

export function requestArtefactShow(threadId: string, title: string): void {
  showHandler?.(threadId, title)
}

/** @internal test helper — drop previews and the handler. */
export function resetArtefactPreviewsForTest(): void {
  previews.clear()
  showHandler = null
}

/**
 * The artefact URI a canvas tool result names, e.g. `ui://canvas/sales-dashboard`.
 *
 * The result text is the summary `flattenMcpContent` writes for a UI resource
 * (`[ui resource: ui://… (text/html, 4.2 KB) — rendered in the canvas]`), which
 * carries the URI verbatim. That URI — not the tool's `title` argument — is the
 * join key, because the artefact's identity is derived from it on every other
 * surface, and a call that passed no title at all still has one.
 */
export function artefactUriFromToolResult(result: string | null): string | null {
  if (!result) return null
  const match = /\bui:\/\/[^\s)\]]+/.exec(result)
  return match ? match[0] : null
}
