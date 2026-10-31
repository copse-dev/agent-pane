import { readFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative } from 'node:path'
import type { InlineVisualizationReference } from '@shared/inline-visualization.ts'
import type { CanvasArtefactReference } from '@shared/types/canvas.ts'
import { getDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { MCP_UI_CANVAS_CAPABILITY } from '@copse/agent/plugins/mcp-ui-canvas-plugin.ts'
import { resolvePathWithinRoot } from './workspace.ts'
import { dispatchCanvasArtefact } from './canvas-dispatch.ts'

const MAX_VISUALIZATION_BYTES = 512 * 1024

/**
 * Resolve an ACP agent's inline visualization reference through Copse's canvas.
 * Gated by the same `copse.mcp-ui-canvas` capability the bundled tool's
 * tool-result path checks (`mcp-registry.ts`'s `summarizeUiResources`) — an ACP
 * agent's own content-reference frames are a second way to reach the same
 * renderer, so disabling the plugin must turn this path off too.
 */
export async function dispatchInlineVisualization(
  reference: InlineVisualizationReference,
  context: { root: string; threadId: string },
): Promise<CanvasArtefactReference> {
  if (!getDefaultPluginRegistry().isCapabilityActive(MCP_UI_CANVAS_CAPABILITY)) {
    throw new Error('MCP-UI canvas is disabled')
  }
  if (!isAbsolute(reference.path)) {
    throw new Error('Inline visualization paths must be absolute')
  }
  const [absolutePath, canonicalRoot] = await Promise.all([
    resolvePathWithinRoot(reference.path, context.root),
    resolvePathWithinRoot('.', context.root),
  ])
  if (extname(absolutePath).toLowerCase() !== '.html') {
    throw new Error('Inline visualizations must reference an HTML file')
  }

  let html: string
  try {
    html = await readFile(absolutePath, 'utf8')
  } catch {
    throw new Error(`Could not read inline visualization: ${reference.path}`)
  }
  if (!html.trim()) throw new Error(`Inline visualization is empty: ${reference.path}`)
  if (Buffer.byteLength(html, 'utf8') > MAX_VISUALIZATION_BYTES) {
    throw new Error(`Inline visualization is too large (max 512 KB): ${reference.path}`)
  }

  const fallbackTitle = basename(absolutePath).replace(/\.[^.]+$/, '')
  const title = reference.title ?? fallbackTitle
  await dispatchCanvasArtefact({
    title,
    mimeType: 'text/html',
    body: html,
    presentation: 'inline',
    threadId: context.threadId,
    sourcePath: relative(canonicalRoot, absolutePath),
  })
  return { title }
}
