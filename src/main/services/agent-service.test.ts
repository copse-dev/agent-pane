import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import * as agentService from './agent-service.ts'
import * as providerSelection from './providers/provider-selection.ts'
import { suggestThreadTitle } from './title-generator.ts'
import { getSetting, setSetting } from './storage/settings.ts'
import type { AgentHost } from '@copse/agent/agent-host.ts'
import type { LLMMessage, LLMProvider, StreamChunk } from '@shared/types'
import { ToolRegistry } from './tool-registry.ts'
import { runWithActiveRunIdentity } from './thread-models.ts'
import { runWithThreadExecutionContext } from './thread-execution-context.ts'
import { PluginRegistry } from '@copse/agent/plugins/plugin-registry.ts'
import { agentsMdPlugin } from '@copse/agent/plugins/agents-md-plugin.ts'
import { definePlugin } from '@copse/agent/plugins/plugin-manifest.ts'
import { setDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import {
  setPluginToolRuntimeController,
  type PluginToolRuntimeController,
} from './plugins/plugin-tool-controller.ts'
import { pluginModelValue } from '@shared/plugin-model.ts'
import { defineTool } from '@shared/types'
import { runWithWorkspaceTrust } from './security/workspace-trust.ts'
import { buildAcpAgentApp, type AcpTurnRunner } from './acp/acp-agent-server.ts'
import { acquireAcpSession, disposeAllAcpSessions } from './acp/acp-session-pool.ts'
import { ACP_CANCELLED_TOOL_CALL_RESULT } from './acp/acp-turn-recovery.ts'
import { DEFAULT_CONTINUATION_BUDGET } from '@copse/agent/hooks/continuation-budget.ts'

async function runSilentAcpToolTurn(continuationBudgetUsed: number): Promise<{
  chunks: StreamChunk[]
  invocationCount: number
  result: agentService.RunAgentResult
}> {
  const root = await mkdtemp(join(tmpdir(), 'copse-agent-acp-recovery-budget-'))
  const suffix = randomUUID()
  const threadId = `thread-acp-recovery-${suffix}`
  const projectId = `project-acp-recovery-${suffix}`
  const agentId = `silent-tool-agent-${suffix}`
  const command = `unused-silent-tool-agent-${suffix}`
  const previousAgents = getSetting('registeredAcpAgents', [])
  const chunks: StreamChunk[] = []
  const registry = new ToolRegistry()
  let invocationCount = 0
  const runner: AcpTurnRunner = async (ctx) => {
    invocationCount++
    const toolCallId = `search-${String(invocationCount)}`
    await ctx.emit({
      type: 'tool_call',
      toolCall: { id: toolCallId, name: 'web_search', args: { query: 'latest PRs' } },
    })
    await ctx.emit({
      type: 'tool_result',
      toolCallId,
      result: 'Five matching pull requests',
      isError: false,
    })
    return { stopReason: 'end_turn' }
  }
  const createTransport = (): Promise<{
    stream: ReturnType<typeof ndJsonStream>
    dispose: () => void
  }> => {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
    const connection = buildAcpAgentApp(runner, { name: 'silent-tool-test-agent' }).connect(
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    )
    return Promise.resolve({
      stream: ndJsonStream(clientToAgent.writable, agentToClient.readable),
      dispose: (): void => {
        connection.close()
      },
    })
  }

  try {
    await setSetting('registeredAcpAgents', [
      { id: agentId, title: 'Silent tool test agent', command, enabled: true },
    ])
    await acquireAcpSession({
      threadId,
      config: { command, cwd: root },
      createTransport,
    })
    const host: AgentHost<StreamChunk> = {
      emit: (_threadId, chunk) => chunks.push(chunk),
    }
    const result = await runWithThreadExecutionContext(
      {
        projectId,
        threadId,
        projectRoot: root,
        root,
        checkoutMode: 'shared',
        branch: null,
      },
      () =>
        runWithActiveRunIdentity(threadId, () =>
          agentService.runAgent(
            threadId,
            'Summarize the matching pull requests.',
            [],
            host,
            registry,
            {
              model: `acp:${agentId}`,
              turnTreeId: `tree-${suffix}`,
              continuationBudgetUsed,
            },
          ),
        ),
    )
    return { chunks, invocationCount, result }
  } finally {
    await disposeAllAcpSessions()
    await setSetting('registeredAcpAgents', previousAgents)
    await rm(root, { recursive: true, force: true })
  }
}

// agent-service is now an orchestrator that re-exports the public surface from the
// focused modules it composes. These tests pin that public surface so IPC callers
// keep importing the same names regardless of where the implementation lives.
describe('agent-service public surface', () => {
  it('exposes the run/abort orchestration entry points', () => {
    assert.equal(typeof agentService.runAgent, 'function')
    assert.equal(typeof agentService.abortAgent, 'function')
  })

  it('re-exports provider-selection helpers from the same module', () => {
    assert.equal(agentService.isLocalChatModel, providerSelection.isLocalChatModel)
    assert.equal(agentService.buildSubagentRoute, providerSelection.buildSubagentRoute)
    assert.equal(agentService.listLmStudioModels, providerSelection.listLmStudioModels)
    assert.equal(
      agentService.invalidateLmStudioModelsCache,
      providerSelection.invalidateLmStudioModelsCache,
    )
    assert.equal(agentService.testLmStudio, providerSelection.testLmStudio)
  })

  it('re-exports the thread title generator', () => {
    assert.equal(agentService.suggestThreadTitle, suggestThreadTitle)
  })
})

// Phase 1 of ACP support decouples the agent core from Electron: runAgent streams
// its output through an injected AgentHost<StreamChunk> rather than a BrowserWindow. This proves
// a full turn can be driven with a mock host and no Electron present.
describe('runAgent AgentHost decoupling', () => {
  it('settles an ACP tool call left open when a successful turn ends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copse-agent-acp-open-tool-'))
    const threadId = 'thread-acp-open-tool'
    const projectId = 'project-acp-open-tool'
    const agentId = 'open-tool-agent'
    const command = 'unused-open-tool-agent'
    const previousAgents = getSetting('registeredAcpAgents', [])
    const received: StreamChunk[] = []
    const registry = new ToolRegistry()
    const runner: AcpTurnRunner = async (ctx) => {
      await ctx.emit({
        type: 'tool_call',
        toolCall: { id: 'orphaned-search', name: 'web_search', args: { query: 'latest PRs' } },
      })
      await ctx.emit({ type: 'text', text: 'Five pull requests landed this week.' })
      return { stopReason: 'end_turn' }
    }
    const createTransport = (): Promise<{
      stream: ReturnType<typeof ndJsonStream>
      dispose: () => void
    }> => {
      const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
      const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
      const connection = buildAcpAgentApp(runner, { name: 'open-tool-test-agent' }).connect(
        ndJsonStream(agentToClient.writable, clientToAgent.readable),
      )
      return Promise.resolve({
        stream: ndJsonStream(clientToAgent.writable, agentToClient.readable),
        dispose: (): void => {
          connection.close()
        },
      })
    }

    try {
      await setSetting('registeredAcpAgents', [
        { id: agentId, title: 'Open tool test agent', command, enabled: true },
      ])
      await acquireAcpSession({
        threadId,
        config: { command, cwd: root },
        createTransport,
      })

      const host: AgentHost<StreamChunk> = {
        emit: (_threadId, chunk) => received.push(chunk),
      }
      await runWithThreadExecutionContext(
        {
          projectId,
          threadId,
          projectRoot: root,
          root,
          checkoutMode: 'shared',
          branch: null,
        },
        () =>
          runWithActiveRunIdentity(threadId, () =>
            agentService.runAgent(threadId, 'What landed this week?', [], host, registry, {
              model: `acp:${agentId}`,
            }),
          ),
      )

      const openedAt = received.findIndex(
        (chunk) => chunk.type === 'tool_call' && chunk.toolCall.id === 'orphaned-search',
      )
      const settledAt = received.findIndex(
        (chunk) =>
          chunk.type === 'tool_call_update' &&
          chunk.toolCallId === 'orphaned-search' &&
          chunk.status === 'error',
      )
      const doneAt = received.findIndex((chunk) => chunk.type === 'done')
      assert.ok(openedAt >= 0, 'the ACP tool call should reach the host')
      assert.ok(settledAt > openedAt, 'the open call should settle after it starts')
      assert.ok(doneAt > settledAt, 'the interrupted verdict should arrive before done')
      const settled = received[settledAt]
      assert.ok(settled?.type === 'tool_call_update')
      assert.equal(settled.result, ACP_CANCELLED_TOOL_CALL_RESULT)
      assert.ok(
        received.some(
          (chunk) => chunk.type === 'text' && chunk.text === 'Five pull requests landed this week.',
        ),
        'the final answer should remain intact',
      )
    } finally {
      await disposeAllAcpSessions()
      await setSetting('registeredAcpAgents', previousAgents)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('names the continuation limit when the real recovery grant is denied', async () => {
    const { chunks, invocationCount, result } = await runSilentAcpToolTurn(
      DEFAULT_CONTINUATION_BUDGET,
    )

    assert.equal(invocationCount, 1, 'a denied grant must not start a recovery turn')
    assert.ok(
      chunks.some(
        (chunk) =>
          chunk.type === 'text' &&
          chunk.text.includes(
            'Copse could not request a final response automatically because this turn reached its continuation limit.',
          ),
      ),
    )
    assert.equal(result.turnOutcome?.recovery?.attempted, false)
    assert.equal(result.turnOutcome.recovery.recovered, false)
  })

  it('keeps failed recovery distinct from a denied recovery grant', async () => {
    const { chunks, invocationCount, result } = await runSilentAcpToolTurn(0)

    assert.equal(invocationCount, 2, 'an available grant should run one recovery turn')
    assert.ok(
      chunks.some(
        (chunk) =>
          chunk.type === 'text' &&
          chunk.text.includes(
            'The external agent stopped after using its tools without providing a final result.',
          ),
      ),
    )
    assert.equal(result.turnOutcome?.recovery?.attempted, true)
    assert.equal(result.turnOutcome.recovery.recovered, false)
  })

  it('streams a fallback notice when a remote agent is selected without a valid key', async () => {
    const priorCursorKey = process.env['CURSOR_API_KEY']
    const priorLmStudioUrl = process.env['COPSE_EVAL_LM_STUDIO_URL']
    delete process.env['CURSOR_API_KEY']
    // The fallback route probes the configured local model. Keep a developer's
    // running LM Studio server out of this unit test: it may accept the request
    // and leave the test waiting on a real generation instead of exercising the
    // unavailable-provider fallback deterministically.
    process.env['COPSE_EVAL_LM_STUDIO_URL'] = 'http://127.0.0.1:1/v1'
    await setSetting('model', 'remote-agent:cursor')

    const received: Array<{ threadId: string; chunk: StreamChunk }> = []
    const host: AgentHost<StreamChunk> = {
      emit: (threadId, chunk) => received.push({ threadId, chunk }),
    }
    const registry = new ToolRegistry()

    try {
      await runWithThreadExecutionContext(
        {
          projectId: 'project-1',
          threadId: 'thread-1',
          projectRoot: '/workspace',
          root: '/workspace',
          checkoutMode: 'shared',
          branch: null,
        },
        () =>
          runWithActiveRunIdentity('thread-1', () =>
            agentService.runAgent('thread-1', 'hello', [], host, registry),
          ),
      )

      assert.ok(received.length >= 1, 'expected the agent run to emit at least one chunk')
      assert.ok(
        received.some(
          (entry) =>
            entry.chunk.type === 'text' &&
            typeof entry.chunk.text === 'string' &&
            entry.chunk.text.includes('Could not run on **Cursor Cloud Agent**'),
        ),
        'expected a fallback notice when the Cursor key is missing',
      )
      assert.ok(
        received.some((entry) => entry.chunk.type === 'done'),
        'the turn should terminate with a done chunk',
      )
    } finally {
      if (priorCursorKey !== undefined) process.env['CURSOR_API_KEY'] = priorCursorKey
      if (priorLmStudioUrl === undefined) delete process.env['COPSE_EVAL_LM_STUDIO_URL']
      else process.env['COPSE_EVAL_LM_STUDIO_URL'] = priorLmStudioUrl
    }
  })

  it('runs a selected-plugin model with bounded history, current images, and usage', async () => {
    const received: StreamChunk[] = []
    const host: AgentHost<StreamChunk> = {
      emit: (_threadId, chunk) => received.push(chunk),
    }
    let invocation: unknown = null
    const runtime: PluginToolRuntimeController = {
      enable: () => Promise.resolve(),
      disable: () => Promise.resolve(),
      isRunning: (pluginId) => pluginId === 'personal.reference-model',
      registrations: () => ({ tools: [], models: [{ id: 'judge:default' }] }),
      invokeTool: () => Promise.reject(new Error('not a tool turn')),
      invokeHook: () => Promise.reject(new Error('not a hook dispatch')),
      invokeModel: (_pluginId, _routeId, input) => {
        invocation = input
        return Promise.resolve({ text: 'Personal judge answer', inputTokens: 12, outputTokens: 4 })
      },
    }
    const route = {
      id: 'judge:default',
      label: 'Reference judge',
      group: 'Personal models',
      supportsImages: true,
    }
    const plugins = new PluginRegistry()
    plugins.register(
      definePlugin(
        {
          name: 'personal.reference-model',
          trust: 'user',
          models: { provides: [route] },
        },
        { modelRoutes: [route] },
      ),
    )
    setDefaultPluginRegistry(plugins)
    setPluginToolRuntimeController(runtime)

    try {
      const result = await runWithThreadExecutionContext(
        {
          projectId: 'project-1',
          threadId: 'thread-personal',
          projectRoot: '/workspace',
          root: '/workspace',
          checkoutMode: 'shared',
          branch: null,
        },
        () =>
          runWithActiveRunIdentity('thread-personal', () =>
            agentService.runAgent(
              'thread-personal',
              [
                { type: 'image', dataUrl: 'data:image/png;base64,QUJD' },
                { type: 'text', text: 'judge this' },
              ],
              [
                { role: 'user', content: 'Long local-model discussion' },
                { role: 'assistant', content: 'Local conclusion to judge' },
              ],
              host,
              new ToolRegistry(),
              { model: pluginModelValue('personal.reference-model', 'judge:default') },
            ),
          ),
      )

      assert.deepEqual(invocation, {
        threadId: 'thread-personal',
        prompt: 'judge this',
        attachments: [{ mimeType: 'image/png', dataBase64: 'QUJD' }],
        history: [
          { role: 'user', text: 'Long local-model discussion' },
          { role: 'assistant', text: 'Local conclusion to judge' },
        ],
      })
      assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 4 })
      assert.ok(
        received.some((chunk) => chunk.type === 'text' && chunk.text === 'Personal judge answer'),
      )
      assert.ok(received.some((chunk) => chunk.type === 'done'))
    } finally {
      setPluginToolRuntimeController(null)
      setDefaultPluginRegistry(null)
    }
  })

  // The host commits history when the run returns, so a turn that never returns
  // takes the user's prompt with it. Checkpoints are what survive that.
  it('checkpoints the prompt before the provider answers, and again as the turn grows', async () => {
    const host: AgentHost<StreamChunk> = { emit: () => undefined }
    const provider: LLMProvider = {
      stream: async function* () {
        yield { type: 'text' as const, text: 'An answer.' }
      },
    }
    const checkpoints: LLMMessage[][] = []

    const result = await runWithThreadExecutionContext(
      {
        projectId: 'project-1',
        threadId: 'thread-checkpoint',
        projectRoot: '/workspace',
        root: '/workspace',
        checkoutMode: 'shared',
        branch: null,
      },
      () =>
        runWithActiveRunIdentity('thread-checkpoint', () =>
          agentService.runAgent(
            'thread-checkpoint',
            'why does this thread forget?',
            [{ role: 'user', content: 'earlier' }],
            host,
            new ToolRegistry(),
            {
              provider,
              contextWindow: 100_000,
              onHistoryCheckpoint: (messages) => checkpoints.push(messages),
            },
          ),
        ),
    )

    assert.ok(checkpoints.length >= 1, 'expected at least one checkpoint')
    // The first one lands before any provider call, and already carries the
    // prompt the old commit-at-the-end behaviour would have lost.
    assert.deepEqual(checkpoints[0], [
      { role: 'user', content: 'earlier' },
      { role: 'user', content: 'why does this thread forget?' },
    ])
    // Turn-local operator steering is stripped from every checkpoint, exactly
    // as it is from the committed history.
    for (const snapshot of checkpoints) {
      assert.ok(
        !snapshot.some((message) => message.role === 'system' || message.role === 'developer'),
      )
    }
    assert.deepEqual(checkpoints.at(-1), result.messages.slice(0, checkpoints.at(-1)?.length))
  })

  it('activates nested instructions on first file access and defers the first edit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copse-agent-nested-instructions-'))
    await mkdir(join(root, 'packages', 'api'), { recursive: true })
    await writeFile(join(root, 'packages', 'api', 'AGENTS.md'), 'Never edit before reading this.')
    const writes: string[] = []
    const registry = new ToolRegistry()
    registry.register(
      defineTool({
        name: 'write_file',
        description: 'Test edit tool',
        parameters: z.object({ path: z.string() }),
        execute: ({ path }) => {
          writes.push(path)
          return Promise.resolve('File written.')
        },
      }),
    )

    let calls = 0
    const provider: LLMProvider = {
      stream: async function* (messages) {
        calls += 1
        const system = messages.find((message) => message.role === 'system')
        assert.ok(system?.role === 'system')
        if (calls === 1) {
          assert.doesNotMatch(system.content, /Never edit before reading this/)
          yield {
            type: 'tool_call' as const,
            toolCall: {
              id: 'first-edit',
              name: 'write_file',
              args: { path: 'packages/api/router.ts' },
            },
          }
          return
        }
        assert.match(system.content, /Never edit before reading this/)
        if (calls === 2) {
          const deferred = messages.find(
            (message) =>
              message.role === 'tool' &&
              message.toolResults.some((result) => result.toolCallId === 'first-edit'),
          )
          assert.ok(deferred?.role === 'tool')
          assert.match(deferred.toolResults[0]?.result ?? '', /Edit deferred/)
          assert.deepEqual(writes, [])
          yield {
            type: 'tool_call' as const,
            toolCall: {
              id: 'retried-edit',
              name: 'write_file',
              args: { path: 'packages/api/router.ts' },
            },
          }
          return
        }
        assert.deepEqual(writes, ['packages/api/router.ts'])
        yield { type: 'text' as const, text: 'Done.' }
      },
    }
    const plugins = new PluginRegistry()
    plugins.register(agentsMdPlugin)
    setDefaultPluginRegistry(plugins)
    await setSetting('subagentsEnabled', false)
    await setSetting('skillsEnabled', false)

    try {
      await runWithWorkspaceTrust(root, true, () =>
        runWithThreadExecutionContext(
          {
            projectId: 'project-nested',
            threadId: 'thread-nested',
            projectRoot: root,
            root,
            checkoutMode: 'shared',
            branch: null,
          },
          () =>
            runWithActiveRunIdentity('thread-nested', () =>
              agentService.runAgent(
                'thread-nested',
                'Make the requested change.',
                [],
                { emit: () => undefined },
                registry,
                {
                  provider,
                  contextWindow: 100_000,
                  model: 'claude-sonnet-4-6',
                  maxSteps: 6,
                  maxLlmCalls: 6,
                },
              ),
            ),
        ),
      )
      assert.equal(calls, 3)
      assert.deepEqual(writes, ['packages/api/router.ts'])
    } finally {
      setDefaultPluginRegistry(null)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('memoizes referenced instruction scopes, notices activations, and refreshes after an AGENTS.md write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copse-agent-nested-discovery-'))
    await mkdir(join(root, 'packages', 'api'), { recursive: true })
    await mkdir(join(root, 'packages', 'web'), { recursive: true })
    await writeFile(join(root, 'packages', 'api', 'AGENTS.md'), 'API rules here.')
    const registry = new ToolRegistry()
    registry.register(
      defineTool({
        name: 'read_file',
        description: 'Test read tool',
        parameters: z.object({ path: z.string() }),
        execute: () => Promise.resolve('contents'),
      }),
    )
    registry.register(
      defineTool({
        name: 'write_file',
        description: 'Test write tool',
        parameters: z.object({ path: z.string(), content: z.string() }),
        execute: async ({ path, content }) => {
          await writeFile(join(root, path), content)
          return 'File written.'
        },
      }),
    )

    const readTool = (
      id: string,
      path: string,
    ): { type: 'tool_call'; toolCall: { id: string; name: string; args: { path: string } } } => ({
      type: 'tool_call',
      toolCall: { id, name: 'read_file', args: { path } },
    })
    let calls = 0
    const provider: LLMProvider = {
      stream: async function* (messages) {
        calls += 1
        const system = messages.find((message) => message.role === 'system')
        assert.ok(system?.role === 'system')
        switch (calls) {
          case 1:
            assert.doesNotMatch(system.content, /API rules here/)
            yield readTool('read-api', 'packages/api/a.ts')
            return
          case 2:
            assert.match(system.content, /API rules here/)
            // The prompt already referenced this missing scope. An external
            // write stays cached until an explicit file-tool invalidation.
            await writeFile(join(root, 'packages', 'web', 'AGENTS.md'), 'Web rules here.')
            yield readTool('read-web-stale', 'packages/web/b.ts')
            return
          case 3:
            assert.doesNotMatch(system.content, /Web rules here/)
            yield {
              type: 'tool_call' as const,
              toolCall: {
                id: 'write-web-agents',
                name: 'write_file',
                args: { path: 'packages/web/AGENTS.md', content: 'Web rules here.' },
              },
            }
            return
          case 4:
            assert.doesNotMatch(system.content, /Web rules here/)
            // A different path than the stale read: the loop skips a repeat of
            // a recent call's exact arguments.
            yield readTool('read-web-fresh', 'packages/web/c.ts')
            return
          default:
            assert.match(system.content, /Web rules here/)
            yield { type: 'text' as const, text: 'Done.' }
        }
      },
    }
    const received: StreamChunk[] = []
    const plugins = new PluginRegistry()
    plugins.register(agentsMdPlugin)
    setDefaultPluginRegistry(plugins)
    await setSetting('subagentsEnabled', false)
    await setSetting('skillsEnabled', false)

    try {
      await runWithWorkspaceTrust(root, true, () =>
        runWithThreadExecutionContext(
          {
            projectId: 'project-nested-discovery',
            threadId: 'thread-nested-discovery',
            projectRoot: root,
            root,
            checkoutMode: 'shared',
            branch: null,
          },
          () =>
            runWithActiveRunIdentity('thread-nested-discovery', () =>
              agentService.runAgent(
                'thread-nested-discovery',
                'Look around packages/web/b.ts.',
                [],
                { emit: (_threadId, chunk) => received.push(chunk) },
                registry,
                {
                  provider,
                  contextWindow: 100_000,
                  model: 'claude-sonnet-4-6',
                  maxSteps: 8,
                  maxLlmCalls: 8,
                },
              ),
            ),
        ),
      )
      assert.equal(calls, 5)

      // One transcript line per activation, landing after that call's result —
      // never between a tool call and its result, where it would strand the card.
      const notices = received.flatMap((chunk, index) =>
        chunk.type === 'text' && chunk.text.includes('Loaded directory-scoped instructions')
          ? [{ index, text: chunk.text }]
          : [],
      )
      assert.deepEqual(
        notices.map((notice) => notice.text),
        [
          '_Loaded directory-scoped instructions from `packages/api/AGENTS.md`._\n\n',
          '_Loaded directory-scoped instructions from `packages/web/AGENTS.md`._\n\n',
        ],
      )
      const resultIndex = (toolCallId: string): number =>
        received.findIndex(
          (chunk) => chunk.type === 'tool_result' && chunk.toolCallId === toolCallId,
        )
      assert.ok(resultIndex('read-api') >= 0)
      assert.ok(notices[0] && notices[0].index > resultIndex('read-api'))
      assert.ok(notices[1] && notices[1].index > resultIndex('read-web-fresh'))
    } finally {
      setDefaultPluginRegistry(null)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('emits a structured terminal record with raw provider failure details', async () => {
    const received: StreamChunk[] = []
    const host: AgentHost<StreamChunk> = {
      emit: (_threadId, chunk) => received.push(chunk),
    }
    const provider: LLMProvider = {
      stream: async function* () {
        yield await Promise.reject(
          new Error(
            '400 {"type":"error","error":{"type":"invalid_request_error","code":"generation_failed","message":"Internal error during token generation"}}',
          ),
        )
      },
    }

    await runWithThreadExecutionContext(
      {
        projectId: 'project-1',
        threadId: 'thread-provider-error',
        projectRoot: '/workspace',
        root: '/workspace',
        checkoutMode: 'shared',
        branch: null,
      },
      () =>
        runWithActiveRunIdentity('thread-provider-error', () =>
          agentService.runAgent(
            'thread-provider-error',
            'trigger failure',
            [],
            host,
            new ToolRegistry(),
            {
              model: 'claude-sonnet-4-6',
              provider,
              contextWindow: 100_000,
            },
          ),
        ),
    )

    const terminal = received.find((chunk) => chunk.type === 'turn_outcome')
    assert.ok(terminal?.type === 'turn_outcome')
    assert.equal(terminal.outcome.status, 'failed')
    assert.equal(terminal.outcome.executor, 'local')
    assert.equal(terminal.outcome.provider, 'anthropic')
    assert.equal(terminal.outcome.error?.code, 'generation_failed')
    assert.match(terminal.outcome.error.message, /Internal error during token generation/)
    assert.ok(received.at(-1)?.type === 'done')
  })

  it('persists an exhausted loop call budget as a failed max-steps outcome', async () => {
    const received: StreamChunk[] = []
    const host: AgentHost<StreamChunk> = {
      emit: (_threadId, chunk) => received.push(chunk),
    }
    const provider: LLMProvider = {
      stream: async function* () {
        yield { type: 'done' as const }
      },
    }

    await runWithThreadExecutionContext(
      {
        projectId: 'project-1',
        threadId: 'thread-run-limit',
        projectRoot: '/workspace',
        root: '/workspace',
        checkoutMode: 'shared',
        branch: null,
      },
      () =>
        runWithActiveRunIdentity('thread-run-limit', () =>
          agentService.runAgent('thread-run-limit', 'keep working', [], host, new ToolRegistry(), {
            model: 'claude-sonnet-4-6',
            provider,
            contextWindow: 100_000,
            maxSteps: 10,
            maxLlmCalls: 1,
            adaptiveExtensions: false,
          }),
        ),
    )

    const terminal = received.find((chunk) => chunk.type === 'turn_outcome')
    assert.ok(terminal?.type === 'turn_outcome')
    assert.equal(terminal.outcome.status, 'failed')
    assert.equal(terminal.outcome.stopReason, 'max_steps')
    assert.equal(terminal.outcome.rawStopReason, 'max_steps')
    assert.deepEqual(received.at(-1), { type: 'done', stopReason: 'max_steps' })
  })

  it('explains an exhausted continuation budget with the remaining plan', async () => {
    const received: StreamChunk[] = []
    let providerCalls = 0
    const provider: LLMProvider = {
      stream: async function* () {
        providerCalls++
        yield { type: 'text' as const, text: 'I could not finish the remaining work.' }
        yield { type: 'done' as const }
      },
    }

    const result = await runWithThreadExecutionContext(
      {
        projectId: 'project-1',
        threadId: 'thread-continuation-limit',
        projectRoot: '/workspace',
        root: '/workspace',
        checkoutMode: 'shared',
        branch: null,
      },
      () =>
        runWithActiveRunIdentity('thread-continuation-limit', () =>
          agentService.runAgent(
            'thread-continuation-limit',
            'keep working',
            [],
            { emit: (_threadId, chunk) => received.push(chunk) },
            new ToolRegistry(),
            {
              model: 'claude-sonnet-4-6',
              provider,
              contextWindow: 100_000,
              turnTreeId: 'tree-continuation-limit',
              continuationBudgetUsed: 5,
              priorTodos: [
                { id: 'implement', content: 'Implement the parser', status: 'in_progress' },
                { id: 'test', content: 'Add the regression tests', status: 'pending' },
              ],
            },
          ),
        ),
    )

    assert.equal(providerCalls, 1, 'the summary must not start another model turn')
    const summaries = received.filter(
      (chunk) => chunk.type === 'text' && chunk.text.includes('automatic continuation limit'),
    )
    assert.equal(summaries.length, 1)
    const summary = summaries[0]
    assert.ok(summary?.type === 'text')
    assert.match(summary.text, /^\n\nCopse reached/)
    assert.match(summary.text, /In progress: Implement the parser/)
    assert.match(summary.text, /Pending: Add the regression tests/)
    assert.match(summary.text, /already at its limit/)
    assert.ok(
      result.messages.some(
        (message) =>
          message.role === 'assistant' &&
          typeof message.content === 'string' &&
          message.content === summary.text,
      ),
      'the streamed explanation must also be persisted in provider history',
    )
    assert.ok(received.at(-1)?.type === 'done')
  })

  it('reports granted allowance reasons without calling them completed attempts', async () => {
    const received: StreamChunk[] = []
    let providerCalls = 0
    const provider: LLMProvider = {
      stream: async function* () {
        providerCalls++
        yield { type: 'text' as const, text: 'The plan item remains open.' }
        yield { type: 'done' as const }
      },
    }

    await runWithThreadExecutionContext(
      {
        projectId: 'project-1',
        threadId: 'thread-continuation-grants',
        projectRoot: '/workspace',
        root: '/workspace',
        checkoutMode: 'shared',
        branch: null,
      },
      () =>
        runWithActiveRunIdentity('thread-continuation-grants', () =>
          agentService.runAgent(
            'thread-continuation-grants',
            'keep working',
            [],
            { emit: (_threadId, chunk) => received.push(chunk) },
            new ToolRegistry(),
            {
              model: 'claude-sonnet-4-6',
              provider,
              contextWindow: 100_000,
              turnTreeId: 'tree-continuation-grants',
              continuationBudgetUsed: 4,
              priorTodos: [
                { id: 'remaining', content: 'Resolve the parser ambiguity', status: 'pending' },
              ],
            },
          ),
        ),
    )

    assert.equal(providerCalls, 2, 'one granted pre-review continuation plus the original turn')
    const summary = received.find(
      (chunk) => chunk.type === 'text' && chunk.text.includes('automatic continuation limit'),
    )
    assert.ok(summary?.type === 'text')
    assert.match(summary.text, /Continuation allowances granted during this run:/)
    assert.match(summary.text, /pre-review plan reconciliation: 1/)
    assert.doesNotMatch(summary.text, /todo closeout/)
    assert.doesNotMatch(summary.text, /attempt/)
  })
})
