/**
 * Push MCP-UI resources extracted from a tool result to the renderer so they can
 * be rendered in the canvas (Browser pane). Kept separate from the MCP registry
 * so the mapping is unit-testable without Electron.
 */
import { extractUiResources } from './mcp/mcp-schema.ts'
import { toCanvasArtefact } from './canvas-artefact.ts'
import type { CanvasArtefact } from '@shared/types/canvas.ts'

/** Channel the preload bridge listens on for canvas artefacts. */
export const CANVAS_ARTEFACT_CHANNEL = 'canvas:artefact'

/** Channel the preload bridge listens on to promote an artefact tab by title. */
export const CANVAS_ARTEFACT_SHOW_CHANNEL = 'canvas:showArtefact'

export type CanvasArtefactSink = (artefact: CanvasArtefact) => void

/**
 * Loads the artefact into the headless agent browser session and returns a
 * preview PNG data URL (or null). Kept separate from the renderer sink because
 * it is awaited: see `dispatchCanvasArtefacts`.
 */
export type CanvasArtefactMirror = (artefact: CanvasArtefact) => Promise<string | null>

let sink: CanvasArtefactSink | null = null
let mirror: CanvasArtefactMirror | null = null

export function setCanvasArtefactSink(next: CanvasArtefactSink | null): void {
  sink = next
}

export function setCanvasArtefactMirror(next: CanvasArtefactMirror | null): void {
  mirror = next
}

/** Mirror and publish one already-resolved canvas artefact. */
export async function dispatchCanvasArtefact(artefact: CanvasArtefact): Promise<void> {
  let preview: string | null = null
  if (mirror) {
    try {
      preview = await mirror(artefact)
    } catch {
      preview = null
    }
  }
  sink?.(preview ? { ...artefact, preview } : artefact)
}

/**
 * Send every UI resource in a tool result to the renderer as a canvas artefact,
 * after mirroring it into the agent browser session.
 *
 * The mirror is awaited, and that is the point: the caller awaits this before
 * returning the tool result, so by the time the model can call
 * `browser_screenshot` the artefact has finished loading in an agent tab. Firing
 * it off unawaited would leave the model screenshotting a blank page whenever it
 * looked immediately — the common case, since looking is the next thing it does.
 *
 * A mirror failure is swallowed to a null preview: being unable to *inspect* an
 * artefact must not stop it reaching the user's canvas.
 */
export async function dispatchCanvasArtefacts(content: unknown, threadId?: string): Promise<void> {
  const artefacts = extractUiResources(content)
    .map(toCanvasArtefact)
    .map((artefact) => (threadId ? { ...artefact, threadId } : artefact))
  if (artefacts.length === 0) return
  for (const artefact of artefacts) {
    await dispatchCanvasArtefact(artefact)
  }
}
