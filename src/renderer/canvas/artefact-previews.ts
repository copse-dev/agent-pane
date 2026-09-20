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
import type { CanvasArtefact } from '@shared/types/canvas.ts'

/** Thread + artefact title -> PNG `data:` URL captured from the agent browser session. */
const previews = new Map<string, string>()

/**
 * A small LRU of complete documents that have just crossed the live artefact
 * channel or were requested for an inline card. The canvas store remains the
 * source of truth; this cache closes the short race where the renderer receives
 * a live artefact just before main's best-effort disk write completes.
 */
const artefacts = new Map<string, CanvasArtefact>()
const artefactReads = new Map<string, Promise<CanvasArtefact | null>>()
const MAX_CACHED_ARTEFACTS = 20

let showHandler: ((threadId: string, title: string) => void) | null = null

function previewKey(threadId: string, title: string): string {
  return JSON.stringify([threadId, title])
}

function artefactKey(projectId: string, threadId: string, title: string): string {
  return JSON.stringify([projectId, threadId, title])
}

function cacheArtefact(key: string, artefact: CanvasArtefact): void {
  artefacts.delete(key)
  artefacts.set(key, artefact)
  while (artefacts.size > MAX_CACHED_ARTEFACTS) {
    const oldest = artefacts.keys().next().value
    if (oldest === undefined) break
    artefacts.delete(oldest)
  }
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

/** Remember a live artefact so its presentation reference can render immediately. */
export function setArtefactContent(
  projectId: string,
  threadId: string,
  artefact: CanvasArtefact,
): void {
  cacheArtefact(artefactKey(projectId, threadId, artefact.title), artefact)
  setArtefactPreview(threadId, artefact.title, artefact.preview)
}

export function getArtefactContent(
  projectId: string,
  threadId: string,
  title: string,
): CanvasArtefact | undefined {
  const key = artefactKey(projectId, threadId, title)
  const artefact = artefacts.get(key)
  if (artefact) cacheArtefact(key, artefact)
  return artefact
}

/**
 * Lazily read one referenced document. Concurrent transcript rebuilds share the
 * same request, while a failed/missing read is not cached so a later disk write
 * or source-file edit can be observed.
 */
export function loadArtefactContent(
  api: ApiClient,
  projectId: string,
  threadId: string,
  title: string,
): Promise<CanvasArtefact | null> {
  const cached = getArtefactContent(projectId, threadId, title)
  if (cached) return Promise.resolve(cached)

  const key = artefactKey(projectId, threadId, title)
  const existing = artefactReads.get(key)
  if (existing) return existing

  const request = api.canvas
    .readArtefact(projectId, threadId, title)
    .then((artefact) => {
      if (artefact?.title === title) setArtefactContent(projectId, threadId, artefact)
      return artefact?.title === title ? artefact : null
    })
    .catch(() => null)
    .finally(() => {
      artefactReads.delete(key)
    })
  artefactReads.set(key, request)
  return request
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
  artefacts.clear()
  artefactReads.clear()
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
