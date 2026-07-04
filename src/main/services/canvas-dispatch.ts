/**
 * Push MCP-UI resources extracted from a tool result to the renderer so they can
 * be rendered in the canvas (Browser pane). Kept separate from the MCP registry
 * so the mapping is unit-testable without Electron.
 */
import { extractUiResources } from './mcp/mcp-schema.ts'
import { toCanvasArtefact } from './canvas-artefact.ts'
import { getMainWindow } from '../windows/create-main-window.ts'

/** Channel the preload bridge listens on for canvas artefacts. */
export const CANVAS_ARTEFACT_CHANNEL = 'canvas:artefact'

/** Send every UI resource in a tool result to the renderer as a canvas artefact. */
export function dispatchCanvasArtefacts(content: unknown): void {
  const artefacts = extractUiResources(content).map(toCanvasArtefact)
  if (artefacts.length === 0) return
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  for (const artefact of artefacts) {
    win.webContents.send(CANVAS_ARTEFACT_CHANNEL, artefact)
  }
}
