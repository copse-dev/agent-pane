import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { McpServerConfig } from '@shared/types/mcp.ts'
import { toAcpMcpServers } from './acp-client.ts'

/**
 * Copse hands its configured MCP servers to the external ACP agent via
 * `session/new` (issue #602, tier 1). `toAcpMcpServers` converts the registry's
 * config shape to ACP's and applies the agent's advertised `mcpCapabilities`:
 * stdio is the protocol baseline, http needs the capability flag.
 */
describe('toAcpMcpServers', () => {
  const stdio: McpServerConfig = {
    name: 'files',
    transport: 'stdio',
    command: 'mcp-files',
    args: ['--root', '/tmp'],
    env: { API_TOKEN: 'tok' },
  }
  const http: McpServerConfig = {
    name: 'docs',
    transport: 'http',
    url: 'https://mcp.example.com',
    headers: { Authorization: 'Bearer x' },
  }

  it('converts stdio configs to the ACP shape', () => {
    assert.deepEqual(toAcpMcpServers([stdio], undefined), [
      {
        name: 'files',
        command: 'mcp-files',
        args: ['--root', '/tmp'],
        env: [{ name: 'API_TOKEN', value: 'tok' }],
      },
    ])
  })

  it('defaults args and env to empty for a bare stdio config', () => {
    const bare: McpServerConfig = { name: 'bare', transport: 'stdio', command: 'srv' }
    assert.deepEqual(toAcpMcpServers([bare], undefined), [
      { name: 'bare', command: 'srv', args: [], env: [] },
    ])
  })

  it('includes http servers only when the agent advertises the capability', () => {
    assert.deepEqual(toAcpMcpServers([http], undefined), [])
    assert.deepEqual(toAcpMcpServers([http], { http: false }), [])
    assert.deepEqual(toAcpMcpServers([http], { http: true }), [
      {
        type: 'http',
        name: 'docs',
        url: 'https://mcp.example.com',
        headers: [{ name: 'Authorization', value: 'Bearer x' }],
      },
    ])
  })

  it('drops configs missing their transport-required field', () => {
    const noCommand: McpServerConfig = { name: 'broken', transport: 'stdio' }
    const noUrl: McpServerConfig = { name: 'broken2', transport: 'http' }
    assert.deepEqual(toAcpMcpServers([noCommand, noUrl], { http: true }), [])
  })

  it('never forwards in-process servers', () => {
    const inProcess: McpServerConfig = { name: 'canvas', transport: 'in-process' }
    assert.deepEqual(toAcpMcpServers([inProcess], { http: true }), [])
  })
})
