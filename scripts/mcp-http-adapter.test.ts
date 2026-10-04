import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { mcpHttpProtocolTransport } from '../tests/e2e/helpers/mcp-http-adapter.mts'

describe('HTTP MCP exact-optional transport adapter', () => {
  it('forwards handlers installed by the protocol after construction', () => {
    const source = new StreamableHTTPServerTransport({})
    const transport = mcpHttpProtocolTransport(source)
    const events: unknown[] = []
    transport.onmessage = (message) => {
      events.push(message)
    }
    transport.onerror = (error) => {
      events.push(error)
    }
    transport.onclose = () => {
      events.push('closed')
    }
    const message = { jsonrpc: '2.0', id: 1, method: 'ping' } as const
    const failure = new Error('transport failed')
    assert.ok(source.onmessage && source.onerror && source.onclose)
    source.onmessage(message)
    source.onerror(failure)
    source.onclose()
    assert.deepEqual(events, [message, failure, 'closed'])
  })
  it('preserves the original close handler for the protocol to chain', () => {
    const source = new StreamableHTTPServerTransport({})
    let closes = 0
    source.onclose = () => {
      closes += 1
    }
    const transport = mcpHttpProtocolTransport(source)
    assert.ok(transport.onclose)
    transport.onclose()
    assert.equal(closes, 1)
  })
})
