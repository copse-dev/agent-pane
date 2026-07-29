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

export type CanvasArtefactSink = (artefact: CanvasArtefact) => void

let sink: CanvasArtefactSink | null = null

export function setCanvasArtefactSink(next: CanvasArtefactSink | null): void {
  sink = next
}

/** Send every UI resource in a tool result to the renderer as a canvas artefact. */
export function dispatchCanvasArtefacts(content: unknown): void {
  const artefacts = extractUiResources(content).map(toCanvasArtefact)
  if (artefacts.length === 0) return
  for (const artefact of artefacts) sink?.(artefact)
}
