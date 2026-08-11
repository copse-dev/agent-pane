import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { ToolRegistry, setPermissionGateForTests } from '../tool-registry.ts'
import { getAdvisorContext } from '../advisor-runner-context.ts'
import {
  startAcpNativeBridge,
  activeBridgeToolNames,
  BRIDGE_TOOL_NAMES,
  BRIDGE_MCP_SERVER_NAME,
  bridgedWorkspaceWritePaths,
  isBridgedNativeToolTitle,
} from './acp-native-bridge.ts'
import type { AcpNativeBridge } from './acp-native-bridge.ts'
import { expectRecord, recordArrayOrEmpty } from '@shared/unknown-value.ts'
import { at } from '@shared/array-utils.ts'
import { PluginRegistry } from '@copse/agent/plugins/plugin-registry.ts'
import { definePlugin } from '@copse/agent/plugins/plugin-manifest.ts'
import { setDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { storageSet } from '../storage/storage.ts'
import {
  requireThreadExecutionOwner,
  type ThreadExecutionOwner,
} from '../thread-execution-context.ts'

/**
 * The native-tool MCP bridge (issue #602, tier 2) exposes a curated slice of
 * the ToolRegistry over localhost HTTP for external ACP agents. These tests
 * drive it as a real MCP client would: JSON-RPC over stateless streamable
 * HTTP, bearer-token gated.
 */

describe('bridgedWorkspaceWritePaths', () => {
  it('attributes successful native file edits to the ACP workspace audit', () => {
    assert.deepEqual(bridgedWorkspaceWritePaths('write_file', { path: './index.html' }), [
      './index.html',
    ])
    assert.deepEqual(
      bridgedWorkspaceWritePaths('rename_file', { from: 'old.css', to: 'styles.css' }),
      ['old.css', 'styles.css'],
    )
    assert.deepEqual(bridgedWorkspaceWritePaths('read_file', { path: 'index.html' }), [])
    assert.deepEqual(bridgedWorkspaceWritePaths('delete_file', { path: 42 }), [])
  })
})

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
    description: 'Run a shell command',
    parameters: z.object({ command: z.string() }),
    execute: ({ command }) => {
      executed.push(`run_shell:${command}`)
      return Promise.resolve(`ran ${command}`)
    },
  })
  registry.register({
    name: 'ask_user',
    description: 'Native-loop orchestration tool; not bridgeable',
    parameters: z.object({ question: z.string() }),
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

function rpcResult(response: Awaited<ReturnType<typeof rpc>>): Record<string, unknown> {
  return expectRecord(expectRecord(response.json)['result'])
}

function contentText(response: Awaited<ReturnType<typeof rpc>>): string | undefined {
  const first = recordArrayOrEmpty(rpcResult(response)['content'])[0]
  return typeof first?.['text'] === 'string' ? first['text'] : undefined
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
    setDefaultPluginRegistry(null)
    await bridge?.close()
    bridge = null
  })

  it('serves only curated tools and executes through the registry gate', async () => {
    const executed: string[] = []
    const permissionChecks: string[] = []
    setPermissionGateForTests((check) => {
      permissionChecks.push(check.toolName)
      return Promise.resolve(true)
    })
    bridge = await startAcpNativeBridge(testRegistry(executed), new AbortController().signal, {
      threadId: 'bridge-test',
    })
    assert.ok(bridge, 'bridge should start when a bridgeable tool is registered')

    for (const init of initialized()) await rpc(bridge, init)
    const list = await rpc(bridge, LIST_TOOLS)
    const tools = recordArrayOrEmpty(rpcResult(list)['tools'])
    assert.deepEqual(
      tools.map((tool) => tool['name']),
      ['staged_diffs', 'run_shell'],
    )
    // Schemas must be draft 2020-12, not the openapi-3.0 flavor: the agent
    // forwards them to the Anthropic API, which 400s on `nullable` / boolean
    // `exclusiveMinimum` (regression: "tools.N.custom.input_schema is invalid").
    const schemaJson = JSON.stringify(tools[0]?.['inputSchema'])
    assert.doesNotMatch(schemaJson, /"nullable"/)
    assert.doesNotMatch(schemaJson, /"exclusiveMinimum":\s*true/)

    const call = await rpc(bridge, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'staged_diffs', arguments: {} },
    })
    assert.equal(contentText(call), 'no pending diffs')
    assert.deepEqual(executed, ['staged_diffs'])

    const shellCall = await rpc(bridge, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'run_shell', arguments: { command: 'npm test' } },
    })
    assert.equal(contentText(shellCall), 'ran npm test')
    assert.deepEqual(executed, ['staged_diffs', 'run_shell:npm test'])
    assert.deepEqual(permissionChecks, ['staged_diffs', 'run_shell'])
  })

  it('attributes successful bridged writes to the current turn', async () => {
    setPermissionGateForTests(() => Promise.resolve(true))
    const registry = testRegistry([])
    registry.register({
      name: 'write_file',
      description: 'Write a workspace file',
      parameters: z.object({ path: z.string(), content: z.string() }),
      execute: () => Promise.resolve('written'),
    })
    bridge = await startAcpNativeBridge(registry, new AbortController().signal, {
      threadId: 'bridge-test',
    })
    assert.ok(bridge)
    const writes: string[] = []
    bridge.setWorkspaceWriteObserver((path) => writes.push(path))
    for (const init of initialized()) await rpc(bridge, init)

    const call = await rpc(bridge, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'write_file',
        arguments: { path: 'index.html', content: '<h1>Cupcakes</h1>' },
      },
    })

    assert.equal(contentText(call), 'written')
    assert.deepEqual(writes, ['index.html'])
  })

  it('forwards tool images as MCP image content, not just the manifest text', async () => {
    // video_frames returns stills alongside its manifest. Dropping them would
    // hand the agent text that says "frames follow" with nothing after it.
    setPermissionGateForTests(() => Promise.resolve(true))
    const registry = testRegistry([])
    registry.register({
      name: 'video_frames',
      description: 'Read a video as stills',
      parameters: z.object({}),
      execute: () =>
        Promise.resolve({
          result: 'Frames follow as images, in order:',
          images: [
            { dataUrl: 'data:image/jpeg;base64,AAAA', name: 'frame-0.000s.jpg' },
            { dataUrl: 'not-a-data-url', name: 'broken.jpg' },
          ],
        }),
    })
    bridge = await startAcpNativeBridge(registry, new AbortController().signal, {
      threadId: 'bridge-test',
    })
    assert.ok(bridge)
    for (const init of initialized()) await rpc(bridge, init)

    const call = await rpc(bridge, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'video_frames', arguments: {} },
    })
    const content = recordArrayOrEmpty(rpcResult(call)['content'])
    assert.deepEqual(
      content.map((block) => block['type']),
      // The malformed data URL is skipped rather than forwarded broken.
      ['text', 'image'],
    )
    assert.equal(at(content, 0)['text'], 'Frames follow as images, in order:')
    assert.equal(at(content, 1)['data'], 'AAAA')
    assert.equal(at(content, 1)['mimeType'], 'image/jpeg')
  })

  it('binds the owning thread so a run-scoped tool knows whose thread it is', async () => {
    // The bridge's MCP handlers are a separate async chain from the ACP turn, so
    // without an explicit rebind `requireThreadExecutionOwner()` throws and any
    // tool that keeps run-scoped state (read_archive) fails on every call.
    setPermissionGateForTests(() => Promise.resolve(true))
    const seen: (ThreadExecutionOwner | string)[] = []
    const registry = testRegistry([])
    registry.register({
      name: 'read_archive',
      description: 'Unpack an archive',
      parameters: z.object({}),
      execute: () => {
        try {
          seen.push(requireThreadExecutionOwner())
        } catch (err) {
          seen.push(err instanceof Error ? err.message : String(err))
        }
        return Promise.resolve('unpacked')
      },
    })
    storageSet('activeProjectId', 'project-1')
    bridge = await startAcpNativeBridge(registry, new AbortController().signal, {
      threadId: 'bridge-thread',
    })
    assert.ok(bridge)
    for (const init of initialized()) await rpc(bridge, init)

    const call = await rpc(bridge, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'read_archive', arguments: {} },
    })
    assert.equal(contentText(call), 'unpacked')
    assert.deepEqual(seen, [{ projectId: 'project-1', threadId: 'bridge-thread' }])
  })

  it('offers the advisor tool when registered, so an ACP executor can consult it', async () => {
    setPermissionGateForTests(() => Promise.resolve(true))
    const registry = testRegistry([])
    registry.register({
      name: 'advisor',
      description: 'Consult a stronger advisor model',
      parameters: z.object({}),
      execute: () => Promise.resolve('Advice: do the smallest slice first.'),
    })
    bridge = await startAcpNativeBridge(registry, new AbortController().signal, {
      threadId: 'bridge-test',
    })
    assert.ok(bridge)

    for (const init of initialized()) await rpc(bridge, init)
    const list = await rpc(bridge, LIST_TOOLS)
    const names = recordArrayOrEmpty(rpcResult(list)['tools']).map((tool) => tool['name'])
    assert.ok(names.includes('advisor'), 'advisor should be offered when registered')

    const call = await rpc(bridge, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'advisor', arguments: {} },
    })
    assert.equal(contentText(call), 'Advice: do the smallest slice first.')
  })

  it('offers enabled plugins’ declared acpTools and removes them atomically on disable', async () => {
    setPermissionGateForTests(() => Promise.resolve(true))
    const plugins = new PluginRegistry()
    plugins.register(
      definePlugin(
        {
          name: 'search-plugin',
          trust: 'first-party',
          stability: 'experimental',
          tools: { native: ['pack_search'], acpTools: ['pack_search'] },
        },
        { toolNames: ['pack_search'] },
      ),
    )
    setDefaultPluginRegistry(plugins)

    const registry = testRegistry([])
    registry.register({
      name: 'pack_search',
      description: 'Search through a plugin tool',
      parameters: z.object({ query: z.string() }),
      execute: ({ query }) => Promise.resolve(`result:${query}`),
    })
    bridge = await startAcpNativeBridge(registry, new AbortController().signal, {
      threadId: 'bridge-test',
    })
    assert.ok(bridge)

    for (const init of initialized()) await rpc(bridge, init)
    const listed = await rpc(bridge, LIST_TOOLS)
    assert.ok(
      recordArrayOrEmpty(rpcResult(listed)['tools']).some((tool) => tool['name'] === 'pack_search'),
    )
    assert.ok(activeBridgeToolNames().includes('pack_search'))
    assert.ok(isBridgedNativeToolTitle('copse-pack_search: pack_search'))

    const call = await rpc(bridge, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'pack_search', arguments: { query: 'docs' } },
    })
    assert.equal(contentText(call), 'result:docs')

    plugins.disable('search-plugin')
    const afterDisable = await rpc(bridge, LIST_TOOLS)
    assert.ok(
      !recordArrayOrEmpty(rpcResult(afterDisable)['tools']).some(
        (tool) => tool['name'] === 'pack_search',
      ),
    )
    assert.ok(!isBridgedNativeToolTitle('copse-pack_search'))
  })

  it('isolates advisor context between concurrent ACP thread bridges', async () => {
    setPermissionGateForTests(() => Promise.resolve(true))
    const registry = testRegistry([])
    registry.register({
      name: 'advisor',
      description: 'Report the bound executor context',
      parameters: z.object({}),
      execute: async () => {
        const context = getAdvisorContext()
        // Force the two HTTP calls to overlap; a shared mutable slot would let
        // the later request replace the earlier request's context here.
        await new Promise((resolve) => setTimeout(resolve, 10))
        const first = context?.getTranscript()[0]
        return `${context?.executorModel ?? 'missing'}:${first?.role ?? 'missing'}`
      },
    })
    const bridgeA = await startAcpNativeBridge(registry, new AbortController().signal, {
      threadId: 'bridge-test',
    })
    const bridgeB = await startAcpNativeBridge(registry, new AbortController().signal, {
      threadId: 'bridge-test',
    })
    assert.ok(bridgeA)
    assert.ok(bridgeB)
    try {
      bridgeA.setAdvisorContext({
        advisorModel: 'advisor-a',
        executorModel: 'executor-a',
        onChunk: () => {},
        getTranscript: () => [{ role: 'user', content: 'thread a' }],
      })
      bridgeB.setAdvisorContext({
        advisorModel: 'advisor-b',
        executorModel: 'executor-b',
        onChunk: () => {},
        getTranscript: () => [{ role: 'assistant', content: 'thread b' }],
      })
      for (const init of initialized()) {
        await Promise.all([rpc(bridgeA, init), rpc(bridgeB, init)])
      }
      const call = (
        id: number,
      ): {
        jsonrpc: string
        id: number
        method: string
        params: { name: string; arguments: Record<string, never> }
      } => ({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'advisor', arguments: {} },
      })
      const [resultA, resultB] = await Promise.all([rpc(bridgeA, call(6)), rpc(bridgeB, call(7))])
      assert.equal(contentText(resultA), 'executor-a:user')
      assert.equal(contentText(resultB), 'executor-b:assistant')
    } finally {
      await Promise.all([bridgeA.close(), bridgeB.close()])
    }
  })

  it('refuses tools outside the curated list even when registered', async () => {
    setPermissionGateForTests(() => Promise.resolve(true))
    bridge = await startAcpNativeBridge(testRegistry([]), new AbortController().signal, {
      threadId: 'bridge-test',
    })
    assert.ok(bridge)
    assert.ok(!BRIDGE_TOOL_NAMES.includes('ask_user'))
    const call = await rpc(bridge, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'ask_user', arguments: { question: 'Continue?' } },
    })
    const result = rpcResult(call)
    assert.equal(result['isError'], true)
    assert.match(contentText(call) ?? '', /not offered/)
  })

  it('rejects requests without the per-turn bearer token', async () => {
    setPermissionGateForTests(() => Promise.resolve(true))
    bridge = await startAcpNativeBridge(testRegistry([]), new AbortController().signal, {
      threadId: 'bridge-test',
    })
    assert.ok(bridge)
    const unauthorized = await rpc(bridge, LIST_TOOLS, 'wrong-token')
    assert.equal(unauthorized.status, 401)
  })

  it('does not start when no bridgeable tool is registered', async () => {
    const empty = new ToolRegistry()
    bridge = await startAcpNativeBridge(empty, new AbortController().signal, {
      threadId: 'bridge-test',
    })
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

  // Claude infixes the server name under the conventional `mcp__` prefix rather
  // than leading with it, so `^copse` never matched and every bridged call
  // double-prompted. Found by a wire trace (#1659), not by the probe.
  it("matches the observed Claude title 'mcp__<server>__<tool>'", () => {
    assert.ok(isBridgedNativeToolTitle('mcp__copse__gh_pr_view'))
    assert.ok(isBridgedNativeToolTitle('mcp__copse__run_shell'))
    assert.ok(isBridgedNativeToolTitle('mcp.copse.staged_diffs'))
    assert.ok(isBridgedNativeToolTitle('MCP__COPSE__GH_PR_LIST'))
  })

  // The `mcp` prefix is deliberately the *only* thing allowed to lead. Admitting
  // an arbitrary leading word would re-admit the prose titles below.
  it('does not let the optional prefix become "any leading word"', () => {
    assert.ok(!isBridgedNativeToolTitle('Run copse gh_pr_list now'))
    assert.ok(!isBridgedNativeToolTitle('mcpserver-copse-gh_pr_list'))
    assert.ok(!isBridgedNativeToolTitle('Edit mcp__copse__gh_pr_list-notes.md'))
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
    assert.ok(!isBridgedNativeToolTitle('copse-ask_user'))
    assert.ok(!isBridgedNativeToolTitle('copse-explore'))
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
