/**
 * Stdio relay for Copse's native-tool bridge (`dist/main/acp-bridge-stdio-relay.js`).
 *
 * The bridge is an authenticated localhost MCP server over streamable HTTP
 * (`acp-native-bridge.ts`). An ACP agent mounts it itself from `session/new`
 * `mcpServers`, but only an agent that advertises `mcpCapabilities.http` can
 * mount an http server. Every ACP agent must support stdio MCP servers, so for
 * the rest Copse offers this relay instead: the agent spawns it like any other
 * stdio server, and it forwards each JSON-RPC message to the same bridge URL
 * with the same bearer token. Calls still execute in Copse's main process
 * through `ToolRegistry`, so nothing about permissions or approvals changes.
 *
 * Run with `ELECTRON_RUN_AS_NODE=1` by the app's own executable. The URL and
 * token arrive in the environment, never on the command line, so they do not
 * show up in a process listing. Must stay free of electron imports.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { isJSONRPCRequest, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import {
  ACP_BRIDGE_RELAY_TOKEN_ENV,
  ACP_BRIDGE_RELAY_URL_ENV,
  relayBridgeTarget,
} from './acp-bridge-stdio-relay-config.ts'

async function main(): Promise<void> {
  const target = relayBridgeTarget(process.env)
  if (!target) {
    process.stderr.write(
      `[copse-bridge-relay] ${ACP_BRIDGE_RELAY_URL_ENV} and ${ACP_BRIDGE_RELAY_TOKEN_ENV} must name a loopback bridge\n`,
    )
    process.exit(2)
  }
  const upstream = new StreamableHTTPClientTransport(target.url, {
    requestInit: { headers: { Authorization: `Bearer ${target.token}` } },
  })
  const downstream = new StdioServerTransport()
  let closing = false
  const close = (code: number): void => {
    if (closing) return
    closing = true
    void Promise.allSettled([upstream.close(), downstream.close()]).then(() => process.exit(code))
  }
  downstream.onmessage = (message: JSONRPCMessage): void => {
    upstream.send(message).catch((error: unknown) => {
      process.stderr.write(`[copse-bridge-relay] ${String(error)}\n`)
      // A request the bridge never answered would hang the agent's tool call;
      // answer it here so the agent sees a failed call instead.
      if (isJSONRPCRequest(message)) {
        void downstream.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: 'Copse tools are unavailable: the app did not answer' },
        })
      }
    })
  }
  upstream.onmessage = (message: JSONRPCMessage): void => {
    void downstream.send(message)
  }
  upstream.onerror = (error: Error): void => {
    process.stderr.write(`[copse-bridge-relay] ${error.message}\n`)
  }
  downstream.onclose = (): void => {
    close(0)
  }
  process.stdin.on('end', () => {
    close(0)
  })
  await upstream.start()
  await downstream.start()
}

void main()
