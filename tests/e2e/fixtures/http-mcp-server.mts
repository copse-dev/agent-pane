// A minimal Streamable HTTP MCP server that requires bearer-token auth, used by
// e2e tests to validate the HTTP transport and Authorization header handling.
//
// Env:
//   MCP_HTTP_TOKEN  required bearer token (requests without it get 401)
//   MCP_HTTP_PORT   port to listen on (0 = pick a free port)
//
// Prints `PORT=<n>` on stdout once listening.
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const token = process.env.MCP_HTTP_TOKEN ?? ''
const port = Number(process.env.MCP_HTTP_PORT ?? '0')

const server = new McpServer({ name: 'http-mock', version: '0.0.1' })

server.registerTool(
  'whoami',
  {
    description: 'Returns the authenticated caller identity',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => ({ content: [{ type: 'text', text: 'authenticated-user' }] }),
)

server.registerTool(
  'add',
  {
    description: 'Add two numbers',
    inputSchema: { a: z.number(), b: z.number() },
    annotations: { readOnlyHint: true },
  },
  async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
)

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
await server.connect(transport)

const httpServer = http.createServer((req, res) => {
  const auth = req.headers['authorization']
  if (!token || auth !== `Bearer ${token}`) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  void transport.handleRequest(req, res)
})

httpServer.listen(port, () => {
  const addr = httpServer.address()
  const actualPort = typeof addr === 'object' && addr ? addr.port : port
  console.log(`PORT=${actualPort}`)
})
