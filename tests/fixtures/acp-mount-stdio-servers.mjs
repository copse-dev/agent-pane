// What every ACP agent's MCP client does with the stdio servers a client
// offers in `session/new`: start each one, list its tools, and stop it. Fixture
// agents that do not advertise http MCP use this to mount Copse's stdio bridge
// relay, so their threads show no "Copse's tools aren't available" notice.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/** Mount the stdio servers in `mcpServers` (entries with no `type`). */
export async function mountStdioServers(mcpServers, clientName = 'fixture-acp-agent') {
  for (const server of (mcpServers ?? []).filter((entry) => !entry.type)) {
    const client = new Client({ name: clientName, version: '0' })
    try {
      await client.connect(
        new StdioClientTransport({
          command: server.command,
          args: server.args ?? [],
          env: {
            ...process.env,
            ...Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value])),
          },
          stderr: 'ignore',
        }),
      )
      await client.listTools()
    } catch {
      // An agent whose MCP server fails keeps going without its tools.
    } finally {
      await client.close().catch(() => {})
    }
  }
}
