import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanvasArtefact } from '@shared/types/canvas.ts'
import { createFirstPartyPluginRegistry } from '@copse/agent/plugins/first-party-plugins.ts'
import { setDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { MCP_UI_CANVAS_PLUGIN_ID } from '@copse/agent/plugins/mcp-ui-canvas-plugin.ts'
import { setCanvasArtefactMirror, setCanvasArtefactSink } from './canvas-dispatch.ts'
import { dispatchInlineVisualization } from './inline-visualization.ts'

const roots: string[] = []

afterEach(async () => {
  setCanvasArtefactSink(null)
  setCanvasArtefactMirror(null)
  setDefaultPluginRegistry(null)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; htmlPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'copse-inline-vis-'))
  roots.push(root)
  const htmlPath = join(root, 'visualizations', 'chart.html')
  await mkdir(join(root, 'visualizations'))
  await writeFile(htmlPath, '<!doctype html><h1>Chart</h1>')
  return { root, htmlPath }
}

describe('dispatchInlineVisualization', () => {
  it('loads a contained HTML file and sends it through the canvas pipeline', async () => {
    const { root, htmlPath } = await fixture()
    const seen: CanvasArtefact[] = []
    setCanvasArtefactSink((artefact) => seen.push(artefact))

    const reference = await dispatchInlineVisualization(
      { path: htmlPath, title: 'Tool rollup approaches' },
      { root, threadId: 'thread-a' },
    )

    assert.deepEqual(reference, { title: 'Tool rollup approaches' })
    assert.deepEqual(seen, [
      {
        title: 'Tool rollup approaches',
        mimeType: 'text/html',
        body: '<!doctype html><h1>Chart</h1>',
        presentation: 'inline',
        threadId: 'thread-a',
        sourcePath: 'visualizations/chart.html',
      },
    ])
  })

  it('rejects paths outside the active thread root', async () => {
    const first = await fixture()
    const second = await fixture()

    await assert.rejects(
      dispatchInlineVisualization(
        { path: second.htmlPath },
        { root: first.root, threadId: 'thread-a' },
      ),
      /outside workspace/i,
    )
  })

  it('rejects non-HTML files', async () => {
    const { root } = await fixture()
    const textPath = join(root, 'notes.txt')
    await writeFile(textPath, 'not html')

    await assert.rejects(
      dispatchInlineVisualization({ path: textPath }, { root, threadId: 'thread-a' }),
      /HTML file/,
    )
  })

  it('refuses to render while the mcp-ui-canvas plugin is disabled', async () => {
    const { root, htmlPath } = await fixture()
    const registry = createFirstPartyPluginRegistry()
    registry.disable(MCP_UI_CANVAS_PLUGIN_ID)
    setDefaultPluginRegistry(registry)
    const seen: CanvasArtefact[] = []
    setCanvasArtefactSink((artefact) => seen.push(artefact))

    await assert.rejects(
      dispatchInlineVisualization({ path: htmlPath }, { root, threadId: 'thread-a' }),
      /disabled/i,
    )
    assert.deepEqual(seen, [], 'a disabled plugin must not reach the canvas sink')
  })
})
