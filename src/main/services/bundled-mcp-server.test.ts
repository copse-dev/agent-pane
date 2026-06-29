import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBundledMcpServers,
  CANVAS_SERVER_NAME,
  type BundledMcpServer,
} from './bundled-mcp-server.ts'
import { extractUiResources } from './mcp-schema.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('bundled MCP servers', () => {
  let servers: BundledMcpServer[] = []

  after(async () => {
    await Promise.allSettled(servers.flatMap((s) => [s.client.close(), s.server.close()]))
  })

  it('exposes the canvas server with a render_html_artefact tool', async () => {
    servers = await createBundledMcpServers()
    const canvas = servers.find((s) => s.name === CANVAS_SERVER_NAME)
    assert.ok(canvas, 'canvas server should be present')

    const { tools } = await canvas.client.listTools()
    assert.ok(
      tools.some((t) => t.name === 'render_html_artefact'),
      'render_html_artefact tool should be registered',
    )
  })

  it('returns a text/html UI resource the host can extract', async () => {
    const canvas = servers.find((s) => s.name === CANVAS_SERVER_NAME)
    assert.ok(canvas, 'canvas server should be present')
    const result = await canvas.client.callTool({
      name: 'render_html_artefact',
      arguments: { title: 'Sales Dashboard', html: '<!doctype html><h1>Sales</h1>' },
    })

    const resources = extractUiResources(result.content)
    assert.equal(resources.length, 1)
    const [resource] = resources
    assert.ok(resource, 'expected one UI resource')
    assert.equal(resource.mimeType, 'text/html')
    assert.match(resource.uri, /^ui:\/\/canvas\//)
    assert.match(resource.text, /<h1>Sales<\/h1>/)
  })

  it('renders an HTML file from the workspace by path, titled from the filename', async () => {
    const canvas = servers.find((s) => s.name === CANVAS_SERVER_NAME)
    assert.ok(canvas, 'canvas server should be present')
    const root = await mkdtemp(join(tmpdir(), 'agent-pane-canvas-'))
    const restore = setWorkspaceRootForTest(root)
    try {
      await writeFile(join(root, 'merge-export-demo.html'), '<!doctype html><h1>From File</h1>')
      const result = await canvas.client.callTool({
        name: 'render_html_artefact',
        arguments: { path: 'merge-export-demo.html' },
      })
      assert.notEqual(result.isError, true)
      const resources = extractUiResources(result.content)
      assert.equal(resources.length, 1)
      const [resource] = resources
      assert.ok(resource, 'expected one UI resource')
      assert.match(resource.text, /<h1>From File<\/h1>/)
      assert.equal(resource.uri, 'ui://canvas/merge-export-demo')
    } finally {
      restore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('errors for a path outside the workspace and when neither path nor html is given', async () => {
    const canvas = servers.find((s) => s.name === CANVAS_SERVER_NAME)
    assert.ok(canvas, 'canvas server should be present')
    const root = await mkdtemp(join(tmpdir(), 'agent-pane-canvas-'))
    const restore = setWorkspaceRootForTest(root)
    try {
      const escape = await canvas.client.callTool({
        name: 'render_html_artefact',
        arguments: { path: '../secret.html' },
      })
      assert.equal(escape.isError, true)

      const empty = await canvas.client.callTool({
        name: 'render_html_artefact',
        arguments: { title: 'nothing' },
      })
      assert.equal(empty.isError, true)
    } finally {
      restore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
