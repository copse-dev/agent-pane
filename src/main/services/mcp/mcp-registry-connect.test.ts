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

  it('awaits the SDK-started close after initialize fails, even when onclose fires before cleanup ends', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const originalClose = clientTransport.close.bind(clientTransport)
    let releaseCleanup = (): void => {}
    let beganCleanup = (): void => {}
    const held = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const closing = new Promise<void>((resolve) => {
      beganCleanup = resolve
    })
    clientTransport.close = async (): Promise<void> => {
      await originalClose()
      beganCleanup()
      await held
    }
    serverTransport.onmessage = (message): void => {
      if ('method' in message && message.method === 'initialize' && 'id' in message) {
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: 'unsupported',
            capabilities: {},
            serverInfo: { name: 'bad-server', version: '1' },
          },
        })
      }
    }
    await serverTransport.start()
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
    let finished = false
    const connecting = connectMcpClient(client, clientTransport, 1000, 'Connecting').finally(() => {
      finished = true
    })
    const rejected = assert.rejects(connecting, /protocol version is not supported/)
    try {
      await closing
      // Allow the SDK's own failed-initialize catch and our caller to settle.
      for (let turn = 0; turn < 10; turn++) await Promise.resolve()
      assert.equal(finished, false, 'The owning connect must still await actual transport cleanup')
    } finally {
      releaseCleanup()
      await rejected
      await serverTransport.close()
    }
  })
})
