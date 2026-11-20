import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ToolRegistry } from '../tool-registry.ts'
import {
  connectMcpClient,
  getMcpServerStatuses,
  loadMcpServers,
  shutdownMcpServers,
} from './mcp-registry.ts'

describe('connectMcpClient', () => {
  it('closes the transport of a server that never finishes initializing', async () => {
    // The server end is started but never answers `initialize`, like a stdio
    // server that is still booting when the connect deadline passes.
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    let serverClosed = false
    serverTransport.onclose = (): void => {
      serverClosed = true
    }
    await serverTransport.start()
    const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} })

    await assert.rejects(
      connectMcpClient(client, clientTransport, 20, 'Connecting to "slow"'),
      /Connecting to "slow" timed out after 20ms/,
    )
    assert.equal(serverClosed, true, 'the timed-out connection is closed, not left initializing')
  })
})

describe('loadMcpServers: a configured server whose tool listing fails', () => {
  it('closes the connected client instead of leaving its process running', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'mcp-registry-connect-'))
    const previous = {
      userData: process.env['COPSE_PANEL_USER_DATA'],
      e2e: process.env['COPSE_E2E'],
      evalFlag: process.env['COPSE_AGENT_EVAL'],
    }
    process.env['COPSE_PANEL_USER_DATA'] = userData
    process.env['COPSE_E2E'] = '1'
    delete process.env['COPSE_AGENT_EVAL']
    await writeFile(
      join(userData, 'mcp.json'),
      JSON.stringify({ mcpServers: { flaky: { command: 'copse-test-never-spawned' } } }),
    )
    // The handshake succeeds (no process is spawned), then `tools/list` fails —
    // a server that initializes but does not implement or errors on listing.
    const connect = mock.method(Client.prototype, 'connect', () => Promise.resolve())
    const listTools = mock.method(Client.prototype, 'listTools', () =>
      Promise.reject(new Error('listing failed')),
    )
    const close = mock.method(Client.prototype, 'close', () => Promise.resolve())
    try {
      await loadMcpServers(new ToolRegistry())
      const status = getMcpServerStatuses().find((entry) => entry.name === 'flaky')
      assert.equal(status?.state, 'error')
      assert.match(status.error ?? '', /listing failed/)
      assert.equal(connect.mock.callCount(), 1)
      assert.equal(close.mock.callCount(), 1, 'the failed server is closed at once')

      // Already closed and untracked: shutdown has nothing left to close.
      await shutdownMcpServers()
      assert.equal(close.mock.callCount(), 1)
    } finally {
      connect.mock.restore()
      listTools.mock.restore()
      close.mock.restore()
      await shutdownMcpServers()
      restoreEnv('COPSE_PANEL_USER_DATA', previous.userData)
      restoreEnv('COPSE_E2E', previous.e2e)
      restoreEnv('COPSE_AGENT_EVAL', previous.evalFlag)
      await rm(userData, { recursive: true, force: true })
    }
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}
