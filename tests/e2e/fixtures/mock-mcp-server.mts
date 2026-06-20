// A minimal stdio MCP server used by e2e tests. It exposes two tools:
//   - echo (read-only)            → returns the provided text
//   - danger (destructive hint)   → returns a fixed string
// Run via: node --experimental-strip-types tests/e2e/fixtures/mock-mcp-server.mts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'mock-mcp', version: '0.0.1' })

server.registerTool(
  'echo',
  {
    description: 'Echo the provided text back',
    inputSchema: { text: z.string().describe('text to echo') },
    annotations: { readOnlyHint: true },
  },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
)

server.registerTool(
  'danger',
  {
    description: 'A destructive operation (mock)',
    inputSchema: {},
    annotations: { destructiveHint: true },
  },
  async () => ({ content: [{ type: 'text', text: 'danger ran' }] }),
)

await server.connect(new StdioServerTransport())
