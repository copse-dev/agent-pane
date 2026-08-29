/**
 * Pure mapping from an extracted MCP-UI resource to a renderer-facing canvas
 * artefact. Kept free of Electron imports so it runs under the unit-test runner.
 */
import type { CanvasArtefact } from '@shared/types/canvas.ts'
import type { McpUiResource } from './mcp/mcp-schema.ts'
import { artefactTitleFromUri } from '@shared/canvas/artefact.ts'

export { artefactTitleFromUri }

export function toCanvasArtefact(resource: McpUiResource): CanvasArtefact {
  return {
    title: artefactTitleFromUri(resource.uri),
    mimeType: resource.mimeType,
    body: resource.text,
    ...(resource.sourcePath ? { sourcePath: resource.sourcePath } : {}),
  }
}
