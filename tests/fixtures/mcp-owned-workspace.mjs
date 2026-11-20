import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

const trace = process.env.MCP_LIFETIME_TRACE
if (!trace) throw new Error('Missing MCP lifetime trace')
const workspace = process.cwd()
let calls = 0
const record = (event) => {
  appendFileSync(trace, `${JSON.stringify({ ...event, pid: process.pid, workspace })}\n`)
}
record({ type: 'started' })
if (process.env.MCP_LIFETIME_HOLD_INITIALIZE === '1') {
  const deadline = Date.now() + 20_000
  while (!existsSync(join(workspace, 'mcp.init-release'))) {
    if (Date.now() > deadline) throw new Error('MCP initialization was not released')
    await delay(5)
  }
}
const server = new McpServer({ name: 'owned-workspace', version: '1.0.0' })
server.registerTool(
  'report_workspace',
  {
    description: `Report the ${process.env.MCP_LIFETIME_LABEL ?? 'original'} workspace`,
    inputSchema: { hold: z.boolean().optional(), fail: z.boolean().optional() },
    annotations: {
      readOnlyHint: process.env.MCP_LIFETIME_READONLY !== 'false',
      destructiveHint: false,
    },
  },
  async ({ hold, fail }, extra) => {
    const call = ++calls
    record({ type: 'entered', call })
    if (hold) {
      const deadline = Date.now() + 20_000
      while (!existsSync(join(workspace, 'mcp.release'))) {
        if (Date.now() > deadline) throw new Error('MCP lifetime call was not released')
        await delay(5, undefined, { signal: extra.signal })
      }
    }
    if (fail) throw new Error('Intentional server failure')
    record({ type: 'completed', call })
    return {
      content: [{ type: 'text', text: JSON.stringify({ workspace, pid: process.pid, call }) }],
    }
  },
)
if (process.env.MCP_LIFETIME_HOLD_LIST === '1') {
  server.server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    record({ type: 'listing' })
    const deadline = Date.now() + 20_000
    try {
      while (!existsSync(join(workspace, 'mcp.list-release'))) {
        if (Date.now() > deadline) throw new Error('MCP tool listing was not released')
        await delay(5, undefined, { signal: extra.signal })
      }
    } catch (error) {
      record({ type: 'list-cancelled' })
      throw error
    }
    return { tools: [] }
  })
}
await server.connect(new StdioServerTransport())
