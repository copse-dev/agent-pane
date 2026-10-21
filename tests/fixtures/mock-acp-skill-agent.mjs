// Independent external executor: real ACP stdio and authenticated HTTP MCP,
// with deterministic skill selection instead of a model. No host internals.
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Readable, Writable } from 'node:stream'
import { URL } from 'node:url'

const sessions = new Map()
agent({ name: 'skill-boundary-probe' })
  .onRequest('initialize', () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { mcpCapabilities: { http: true } },
  }))
  .onRequest('authenticate', () => ({}))
  .onRequest('session/new', (ctx) => {
    const sessionId = `skill-session-${String(sessions.size)}`
    sessions.set(
      sessionId,
      ctx.params.mcpServers.find((server) => server.type === 'http'),
    )
    return { sessionId }
  })
  .onRequest('session/prompt', async (ctx) => {
    const text = ctx.params.prompt
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
    if (!text.includes('<available_skills>') || !text.includes('name="tiny"')) {
      throw new Error('Copse skill catalog was not delivered to the executor')
    }
    const server = sessions.get(ctx.params.sessionId)
    if (!server) throw new Error('Copse HTTP MCP bridge was not offered')
    const client = new Client({ name: 'skill-reader', version: '1' })
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: {
            headers: Object.fromEntries(
              server.headers.map((header) => [header.name, header.value]),
            ),
          },
        }),
      )
      const tools = await client.listTools()
      if (!tools.tools.some((tool) => tool.name === 'read_skill'))
        throw new Error('read_skill was not received')
      const instructions = await client.callTool({
        name: 'read_skill',
        arguments: { name: 'tiny' },
      })
      const reference = await client.callTool({
        name: 'read_skill',
        arguments: { name: 'tiny', path: 'reference.md' },
      })
      if (instructions.isError || reference.isError)
        throw new Error(JSON.stringify([instructions, reference]))
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: JSON.stringify([instructions.content, reference.content]),
          },
        },
      })
      return { stopReason: 'end_turn' }
    } finally {
      await client.close()
    }
  })
  .onNotification('session/cancel', () => {})
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
