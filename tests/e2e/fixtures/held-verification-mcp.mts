import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const directory = process.env['MCP_VERIFICATION_HOLD_DIR']
if (!directory) throw new Error('Missing verification hold directory')
const server = new McpServer({ name: 'project-verification', version: '1.0.0' })
let calls = 0
server.registerTool(
  'verify_project',
  {
    description: 'Verify the project and report the result',
    inputSchema: {},
    annotations: { title: 'Verify project', readOnlyHint: true, destructiveHint: false },
  },
  async (_args, extra) => {
    calls++
    writeFileSync(join(directory, 'entered.json'), JSON.stringify({ calls, pid: process.pid }))
    const deadline = Date.now() + 30_000
    while (!existsSync(join(directory, 'release'))) {
      if (Date.now() > deadline) throw new Error('Verification was not released')
      await delay(10, undefined, { signal: extra.signal })
    }
    return { content: [{ type: 'text', text: 'Verification completed successfully.' }] }
  },
)
await server.connect(new StdioServerTransport())
