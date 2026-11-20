#!/usr/bin/env node
/**
 * A real ACP subprocess with durable conversation history. Reattachment mounts
 * the newly offered HTTP bridge but retains the old prompts, like real adapters.
 * Calls only the server identified by Copse's current or remembered guidance;
 * no prefix or tool-name fallback can make the lifecycle assertion pass.
 */
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import { URL } from 'node:url'
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk/unstable'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '../../packages/std/src/safe-json.ts'

const storePath = process.argv[2]
if (!storePath) throw new Error('A private session store path is required')
const loadOnly = process.argv.includes('--load-only')
const historySchema = z.object({ sessionId: z.string(), prompts: z.array(z.string()) })
let stored = await readFile(storePath, 'utf8')
  .then((text) => safeJsonParse(text, decodeWithSchema(historySchema)))
  .catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
let mounted = []
let attachedBy = 'new'

async function withMcp(server, action) {
  const headers = Object.fromEntries((server.headers ?? []).map(({ name, value }) => [name, value]))
  const client = new Client({ name: 'bridge-identity-fixture', version: '1' })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }),
    )
    return await action(client)
  } finally {
    await client.close()
  }
}

async function mount(servers) {
  mounted = servers.filter((server) => server.type === 'http')
  for (const server of mounted) await withMcp(server, (client) => client.listTools())
}

async function attach(ctx, method) {
  if (!stored || stored.sessionId !== ctx.params.sessionId)
    throw RequestError.resourceNotFound(ctx.params.sessionId)
  attachedBy = method
  await mount(ctx.params.mcpServers)
  if (method === 'load') {
    for (const text of stored.prompts) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId: stored.sessionId,
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } },
      })
    }
  }
  return {}
}

agent({ name: 'bridge-identity-fixture' })
  .onRequest('initialize', () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      mcpCapabilities: { http: true },
      ...(!loadOnly ? { sessionCapabilities: { resume: {} } } : {}),
    },
  }))
  .onRequest('session/new', async (ctx) => {
    stored = { sessionId: randomUUID(), prompts: [] }
    await writeFile(storePath, JSON.stringify(stored))
    await mount(ctx.params.mcpServers)
    return { sessionId: stored.sessionId }
  })
  .onRequest('session/resume', (ctx) => attach(ctx, 'resume'))
  .onRequest('session/load', (ctx) => attach(ctx, 'load'))
  .onRequest('session/prompt', async (ctx) => {
    if (!stored || stored.sessionId !== ctx.params.sessionId)
      throw RequestError.resourceNotFound(ctx.params.sessionId)
    const prompt = ctx.params.prompt
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
    const historyLength = stored.prompts.length
    stored.prompts.push(prompt)
    await writeFile(storePath, JSON.stringify(stored))
    const guidedServer = [...stored.prompts]
      .reverse()
      .map(
        (text) =>
          /Copse native bridge for this turn: "([^"]+)"/.exec(text)?.[1] ??
          /Prefer the tools of Copse's MCP server, "([^"]+)"/.exec(text)?.[1],
      )
      .find(Boolean)
    const server = mounted.find((candidate) => candidate.name === guidedServer)
    const result = server
      ? await withMcp(server, (client) => client.callTool({ name: 'read_file', arguments: {} }))
      : null
    await ctx.client.notify(methods.client.session.update, {
      sessionId: stored.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `identity:${JSON.stringify({
            attachedBy,
            historyLength,
            processId: process.pid,
            prompt,
            guidedServer,
            mountedServers: mounted.map((candidate) => candidate.name),
            result,
          })}`,
        },
      },
    })
    return { stopReason: 'end_turn' }
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
