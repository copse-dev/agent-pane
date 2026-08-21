import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as agentService from './agent-service.ts'
import * as providerSelection from './providers/provider-selection.ts'
import { suggestThreadTitle } from './title-generator.ts'
import { setSetting } from './storage/settings.ts'
import type { AgentHost } from '@copse/agent/agent-host.ts'
import type { LLMMessage, LLMProvider, StreamChunk } from '@shared/types'
import { ToolRegistry } from './tool-registry.ts'
import { runWithActiveRunIdentity } from './thread-models.ts'
import { runWithThreadExecutionContext } from './thread-execution-context.ts'
import { PluginRegistry } from '@copse/agent/plugins/plugin-registry.ts'
import { definePlugin } from '@copse/agent/plugins/plugin-manifest.ts'
import { setDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import {
  setPluginToolRuntimeController,
  type PluginToolRuntimeController,
} from './plugins/plugin-tool-controller.ts'
import { pluginModelValue } from '@shared/plugin-model.ts'

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
  it('streams a fallback notice when a remote agent is selected without a valid key', async () => {
    const priorCursorKey = process.env['CURSOR_API_KEY']
    delete process.env['CURSOR_API_KEY']
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
})
