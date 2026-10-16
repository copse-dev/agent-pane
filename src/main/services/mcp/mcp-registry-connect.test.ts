import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { connectMcpClient } from './mcp-registry.ts'

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
