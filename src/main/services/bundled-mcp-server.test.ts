import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  createBundledMcpServers,
  CANVAS_SERVER_NAME,
  type BundledMcpServer,
} from './bundled-mcp-server.ts'
import { extractUiResources } from './mcp-schema.ts'

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
    const canvas = servers.find((s) => s.name === CANVAS_SERVER_NAME)!
    const result = await canvas.client.callTool({
      name: 'render_html_artefact',
      arguments: { title: 'Sales Dashboard', html: '<!doctype html><h1>Sales</h1>' },
    })

    const resources = extractUiResources(result.content)
    assert.equal(resources.length, 1)
    assert.equal(resources[0]!.mimeType, 'text/html')
    assert.match(resources[0]!.uri, /^ui:\/\/canvas\//)
    assert.match(resources[0]!.text, /<h1>Sales<\/h1>/)
  })
})
