import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { ToolRegistry, setPermissionGateForTests } from '../tool-registry.ts'
import {
  startAcpNativeBridge,
  BRIDGE_TOOL_NAMES,
  BRIDGE_MCP_SERVER_NAME,
  isBridgedNativeToolTitle,
} from './acp-native-bridge.ts'
import type { AcpNativeBridge } from './acp-native-bridge.ts'

/**
 * The native-tool MCP bridge (issue #602, tier 2) exposes a curated slice of
 * the ToolRegistry over localhost HTTP for external ACP agents. These tests
 * drive it as a real MCP client would: JSON-RPC over stateless streamable
 * HTTP, bearer-token gated.
 */

function testRegistry(executed: string[]): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register({
    name: 'staged_diffs',
    description: 'List pending proposed file edits',
    // Shapes that diverge between JSON Schema flavors: openapi-3.0 renders
    // these as `nullable: true` / boolean `exclusiveMinimum`, which the
    // Anthropic API rejects when the agent forwards bridge tool schemas.
    parameters: z.object({
      limit: z.number().int().gt(0).optional(),
      note: z.string().nullable().optional(),
    }),
    execute: () => {
      executed.push('staged_diffs')
      return Promise.resolve('no pending diffs')
    },
  })
  registry.register({
    name: 'run_shell',
    description: 'Not bridgeable',
    parameters: z.object({ command: z.string() }),
    execute: () => Promise.resolve('should never run over the bridge'),
  })
  return registry
}

async function rpc(
  bridge: AcpNativeBridge,
  body: unknown,
  token = bridge.token,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(bridge.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  // Streamable HTTP may answer as SSE; unwrap the single data event if so.
  const dataLine = text
    .split('\n')
    .find((line) => line.startsWith('data:'))
    ?.slice(5)
  const payload = dataLine ?? text
  return { status: response.status, json: payload ? JSON.parse(payload) : null }
}

const LIST_TOOLS = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }

function initialized(): unknown[] {
  return [
    {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    },
  ]
}

describe('startAcpNativeBridge', () => {
  let bridge: AcpNativeBridge | null = null

  afterEach(async () => {
    setPermissionGateForTests(null)
    await bridge?.close()
    bridge = null
  })

  it('serves only curated tools and executes through the registry gate', async () => {
    const executed: string[] = []
    setPermissionGateForTests(() => Promise.resolve(true))
    bridge = await startAcpNativeBridge(testRegistry(executed), new AbortController().signal)
    assert.ok(bridge, 'bridge should start when a bridgeable tool is registered')

    for (const init of initialized()) await rpc(bridge, init)
    const list = await rpc(bridge, LIST_TOOLS)
    const tools = (list.json as { result: { tools: { name: string; inputSchema: unknown }[] } })
      .result.tools
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['staged_diffs'],
    )
    // Schemas must be draft 2020-12, not the openapi-3.0 flavor: the agent
    // forwards them to the Anthropic API, which 400s on `nullable` / boolean
    // `exclusiveMinimum` (regression: "tools.N.custom.input_schema is invalid").
    const schemaJson = JSON.stringify(tools[0]?.inputSchema)
    assert.doesNotMatch(schemaJson, /"nullable"/)
    assert.doesNotMatch(schemaJson, /"exclusiveMinimum":\s*true/)

    const call = await rpc(bridge, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'staged_diffs', arguments: {} },
    })
    const result = (call.json as { result: { content: { text: string }[] } }).result
    assert.equal(result.content[0]?.text, 'no pending diffs')
    assert.deepEqual(executed, ['staged_diffs'])
  })

  it('refuses tools outside the curated list even when registered', async () => {
    setPermissionGateForTests(() => Promise.resolve(true))
    bridge = await startAcpNativeBridge(testRegistry([]), new AbortController().signal)
    assert.ok(bridge)
    assert.ok(!BRIDGE_TOOL_NAMES.includes('run_shell'))
    const call = await rpc(bridge, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'run_shell', arguments: { command: 'rm -rf /' } },
    })
    const result = (call.json as { result: { content: { text: string }[]; isError?: boolean } })
      .result
    assert.equal(result.isError, true)
    assert.match(result.content[0]?.text ?? '', /not offered/)
  })

  it('rejects requests without the per-turn bearer token', async () => {
    setPermissionGateForTests(() => Promise.resolve(true))
    bridge = await startAcpNativeBridge(testRegistry([]), new AbortController().signal)
    assert.ok(bridge)
    const unauthorized = await rpc(bridge, LIST_TOOLS, 'wrong-token')
    assert.equal(unauthorized.status, 401)
  })

  it('does not start when no bridgeable tool is registered', async () => {
    const empty = new ToolRegistry()
    bridge = await startAcpNativeBridge(empty, new AbortController().signal)
    assert.equal(bridge, null)
  })
})

describe('isBridgedNativeToolTitle', () => {
  it("matches the observed Cursor title '<server>-<tool>: <tool>'", () => {
    assert.ok(isBridgedNativeToolTitle(`${BRIDGE_MCP_SERVER_NAME}-gh_pr_list: gh_pr_list`))
    assert.ok(isBridgedNativeToolTitle('copse-semantic_search'))
    assert.ok(isBridgedNativeToolTitle('copse-fetch_url: fetch_url'))
  })

  it('accepts any single non-alphanumeric separator after the server name', () => {
    assert.ok(isBridgedNativeToolTitle('copse/gh_pr_view'))
    assert.ok(isBridgedNativeToolTitle('copse.staged_diffs'))
    assert.ok(isBridgedNativeToolTitle('copse_wait_for_ci_checks'))
    assert.ok(isBridgedNativeToolTitle('COPSE-GH_PR_LIST')) // case-insensitive
  })

  it('unwraps an inline-code-wrapped title before matching', () => {
    assert.ok(isBridgedNativeToolTitle('`copse-gh_pr_list`'))
  })

  it('only matches at the start, so prose that merely mentions copse is safe', () => {
    // `copse` is a common token in this repo; a description that happens to
    // contain a bridged tool name must not be taken for a bridged call.
    assert.ok(!isBridgedNativeToolTitle('Edit copse-gh_pr_list-notes.md'))
    assert.ok(!isBridgedNativeToolTitle('Sync copse - gh_pr_list config'))
    assert.ok(!isBridgedNativeToolTitle('Run copse gh_pr_list now'))
  })

  it('rejects titles that lack the bridge server prefix', () => {
    // A bare bridged tool name (or one from some *other* server) is not ours.
    assert.ok(!isBridgedNativeToolTitle('gh_pr_list'))
    assert.ok(!isBridgedNativeToolTitle('otherserver-fetch_url'))
    assert.ok(!isBridgedNativeToolTitle('fetch_url: fetch_url'))
  })

  it('rejects a copse-prefixed title for a tool we do not bridge', () => {
    assert.ok(!isBridgedNativeToolTitle('copse-run_shell'))
    assert.ok(!isBridgedNativeToolTitle('copse-delete_file'))
    // A bridged name with trailing chars is a different, unknown tool.
    assert.ok(!isBridgedNativeToolTitle('copse-gh_pr_lists'))
  })

  it('rejects empty and non-title input', () => {
    assert.ok(!isBridgedNativeToolTitle(''))
    assert.ok(!isBridgedNativeToolTitle(null))
    assert.ok(!isBridgedNativeToolTitle(undefined))
  })

  it('keeps every curated bridged tool matchable', () => {
    for (const tool of BRIDGE_TOOL_NAMES) {
      assert.ok(
        isBridgedNativeToolTitle(`${BRIDGE_MCP_SERVER_NAME}-${tool}`),
        `expected ${tool} to be recognised`,
      )
    }
  })
})
