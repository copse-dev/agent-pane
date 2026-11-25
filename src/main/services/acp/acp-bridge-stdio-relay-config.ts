/**
 * How Copse offers its native-tool bridge to an ACP agent that cannot mount an
 * http MCP server: as a stdio MCP server that runs `acp-bridge-stdio-relay.ts`
 * under the app's own executable. Kept apart from the relay entry so the
 * session code can build the offer without bundling the relay.
 */
import { join } from 'node:path'
import type { McpServerStdio } from '@agentclientprotocol/sdk/unstable'

export const ACP_BRIDGE_RELAY_URL_ENV = 'COPSE_BRIDGE_URL'
export const ACP_BRIDGE_RELAY_TOKEN_ENV = 'COPSE_BRIDGE_TOKEN'

/** Where the bundled relay sits: next to the main bundle and the session host. */
export function acpBridgeRelayScriptPath(dir: string = __dirname): string {
  return join(dir, 'acp-bridge-stdio-relay.js')
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * The bridge the relay forwards to, read from its environment. Only a plain
 * http loopback URL is accepted: the bridge never listens anywhere else, and
 * the relay must not become a way to send Copse's bearer token off the machine.
 */
export function relayBridgeTarget(
  env: Readonly<Record<string, string | undefined>>,
): { url: URL; token: string } | null {
  const rawUrl = env[ACP_BRIDGE_RELAY_URL_ENV]
  const token = env[ACP_BRIDGE_RELAY_TOKEN_ENV]
  if (!rawUrl || !token) return null
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) return null
  return { url, token }
}

/**
 * The `session/new` entry that mounts the bridge over stdio. The agent spawns
 * `execPath` in Node mode with the relay script; the URL and token travel in
 * the server's environment, as the http offer carries them in its headers.
 */
export function acpBridgeStdioServer(
  bridge: { url: string; token: string; serverName: string },
  runtime: { execPath: string; scriptPath: string } = {
    execPath: process.execPath,
    scriptPath: acpBridgeRelayScriptPath(),
  },
): McpServerStdio {
  return {
    name: bridge.serverName,
    command: runtime.execPath,
    args: [runtime.scriptPath],
    env: [
      { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
      { name: ACP_BRIDGE_RELAY_URL_ENV, value: bridge.url },
      { name: ACP_BRIDGE_RELAY_TOKEN_ENV, value: bridge.token },
    ],
  }
}
