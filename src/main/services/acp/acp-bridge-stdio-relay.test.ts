import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as esbuild from 'esbuild'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ToolRegistry } from '../tool-registry.ts'
import { startAcpNativeBridge, type AcpNativeBridge } from './acp-native-bridge.ts'
import {
  ACP_BRIDGE_RELAY_TOKEN_ENV,
  ACP_BRIDGE_RELAY_URL_ENV,
  acpBridgeStdioServer,
  relayBridgeTarget,
} from './acp-bridge-stdio-relay-config.ts'

describe('relayBridgeTarget', () => {
  const env = (url: string): Record<string, string> => ({
    [ACP_BRIDGE_RELAY_URL_ENV]: url,
    [ACP_BRIDGE_RELAY_TOKEN_ENV]: 'secret',
  })

  it('accepts the loopback http URL the bridge listens on', () => {
    assert.equal(relayBridgeTarget(env('http://127.0.0.1:4321/mcp'))?.url.port, '4321')
    assert.ok(relayBridgeTarget(env('http://[::1]:4321/mcp')))
  })

  it('refuses anything that would carry the token off the machine', () => {
    assert.equal(relayBridgeTarget(env('https://127.0.0.1:4321/mcp')), null)
    assert.equal(relayBridgeTarget(env('http://example.com/mcp')), null)
    assert.equal(relayBridgeTarget(env('http://127.0.0.1.example.com/mcp')), null)
    assert.equal(relayBridgeTarget(env('not a url')), null)
    assert.equal(relayBridgeTarget({ [ACP_BRIDGE_RELAY_URL_ENV]: 'http://127.0.0.1:1/mcp' }), null)
  })
})

describe('acpBridgeStdioServer', () => {
  it('passes the URL and token in the environment, not the arguments', () => {
    const server = acpBridgeStdioServer(
      { url: 'http://127.0.0.1:9/mcp', token: 'tok', serverName: 'copse-abc' },
      { execPath: '/app/Copse', scriptPath: '/app/dist/main/acp-bridge-relay.js' },
    )
    assert.equal(server.name, 'copse-abc')
    assert.equal(server.command, '/app/Copse')
    assert.deepEqual(server.args, ['/app/dist/main/acp-bridge-relay.js'])
    assert.deepEqual(server.env, [
      { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
      { name: ACP_BRIDGE_RELAY_URL_ENV, value: 'http://127.0.0.1:9/mcp' },
      { name: ACP_BRIDGE_RELAY_TOKEN_ENV, value: 'tok' },
    ])
    assert.ok(!server.args.join(' ').includes('tok'))
  })
})

/**
 * The relay as an agent sees it: a stdio MCP server spawned from the exact
 * `session/new` entry Copse offers, reaching a real bridge and its registry.
 */
describe('stdio relay to the native-tool bridge', () => {
  let dir: string
  let scriptPath: string
  let bridge: AcpNativeBridge | null = null
  const executed: string[] = []

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'copse-bridge-relay-'))
    scriptPath = join(dir, 'acp-bridge-relay.js')
    await esbuild.build({
      entryPoints: [resolve('src/main/services/acp/acp-bridge-stdio-relay.ts')],
      outfile: scriptPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      alias: { '@shared': resolve('src/shared') },
      logLevel: 'silent',
    })
    writeFileSync(join(dir, 'package.json'), '{ "type": "commonjs" }\n')
    const registry = new ToolRegistry()
    registry.register({
      name: 'git_status',
      description: 'Show the working tree status',
      parameters: z.object({ short: z.boolean().optional() }),
      execute: () => {
        executed.push('git_status')
        return Promise.resolve('clean')
      },
    })
    bridge = await startAcpNativeBridge(registry, new AbortController().signal, {
      threadId: 'relay-thread',
    })
    // The turn the dispatcher would bind while the agent runs.
    bridge?.setExecutionContext({
      projectId: 'project-1',
      threadId: 'relay-thread',
      projectRoot: dir,
      root: dir,
      checkoutMode: 'worktree',
      branch: 'copse/relay-thread',
    })
  })

  after(async () => {
    await bridge?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function connect(token: string): Promise<Client> {
    assert.ok(bridge)
    const offer = acpBridgeStdioServer(
      { url: bridge.url, token, serverName: bridge.serverName },
      { execPath: process.execPath, scriptPath },
    )
    const client = new Client({ name: 'relay-test-agent', version: '1' })
    await client.connect(
      new StdioClientTransport({
        command: offer.command,
        args: offer.args,
        env: Object.fromEntries(offer.env.map(({ name, value }) => [name, value])),
        stderr: 'pipe',
      }),
    )
    return client
  }

  it('lists and calls Copse tools through the registry', async () => {
    assert.ok(bridge)
    const client = await connect(bridge.token)
    try {
      const { tools } = await client.listTools()
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ['git_status'],
      )
      const result = await client.callTool({ name: 'git_status', arguments: {} })
      assert.deepEqual(result.content, [{ type: 'text', text: 'clean' }])
      assert.deepEqual(executed, ['git_status'])
    } finally {
      await client.close()
    }
  })

  it('cannot reach the bridge without its token', async () => {
    await assert.rejects(async () => {
      const client = await connect('wrong-token')
      try {
        await client.listTools()
      } finally {
        await client.close()
      }
    })
  })
})
