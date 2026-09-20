import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { McpServerConfig } from '@shared/types/mcp.ts'
import { toAcpMcpServers } from './acp-client.ts'

/**
 * Configured MCP calls must stay visible to Copse so the host can enforce
 * hooks, read-only mode, and per-tool allow/ask/block policy. The registered
 * tools are exposed through the authenticated native bridge; no raw server
 * config is handed to the external ACP agent.
 */
describe('toAcpMcpServers', () => {
  const stdio: McpServerConfig = {
    name: 'files',
    transport: 'stdio',
    command: 'mcp-files',
    args: ['--root', '/workspace'],
    env: { API_TOKEN: 'tok' },
  }
  const http: McpServerConfig = {
    name: 'docs',
    transport: 'http',
    url: 'https://mcp.example.com',
    headers: { Authorization: 'Bearer x' },
  }

  it('does not forward stdio servers the agent could call outside Copse policy', () => {
    assert.deepEqual(toAcpMcpServers([stdio], undefined), [])
  })

  it('does not forward http servers even when the agent can mount them directly', () => {
    assert.deepEqual(toAcpMcpServers([http], { http: true }), [])
  })

  it('keeps the empty configuration empty', () => {
    assert.deepEqual(toAcpMcpServers([], { http: true }), [])
  })
})
