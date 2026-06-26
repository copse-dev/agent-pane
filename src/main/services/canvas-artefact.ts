/**
 * Pure mapping from an extracted MCP-UI resource to a renderer-facing canvas
 * artefact. Kept free of Electron imports so it runs under the unit-test runner.
 */
import type { CanvasArtefact } from '@shared/types/canvas.ts'
import type { McpUiResource } from './mcp-schema.ts'

/** Derive a friendly tab title from a `ui://server/<name>` resource URI. */
export function artefactTitleFromUri(uri: string): string {
  // Drop the scheme (e.g. `ui://`) so the title comes from the path segments.
  const path = uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const tail = path.split('/').filter(Boolean).pop()
  if (!tail) return 'Artefact'
  return tail.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function toCanvasArtefact(resource: McpUiResource): CanvasArtefact {
  return {
    title: artefactTitleFromUri(resource.uri),
    mimeType: resource.mimeType,
    body: resource.text,
  }
}
