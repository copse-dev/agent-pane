import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as agentService from './agent-service.ts'
import * as providerSelection from './provider-selection.ts'
import { suggestThreadTitle } from './title-generator.ts'
import { setSetting } from './storage/settings.ts'
import type { AgentHost } from '@shared/agent/agent-host.ts'
import type { StreamChunk } from '@shared/types'
import type { ToolRegistry } from './tool-registry.ts'

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
// its output through an injected AgentHost rather than a BrowserWindow. This proves
// a full turn can be driven with a mock host and no Electron present.
describe('runAgent AgentHost decoupling', () => {
  it('streams chunks through a mock AgentHost with no BrowserWindow', async () => {
    // Drive the remote-agent branch, which fails fast offline (no Cursor API key)
    // and reports the error back through the host — a deterministic turn that needs
    // neither a network nor a renderer.
    const priorCursorKey = process.env['CURSOR_API_KEY']
    delete process.env['CURSOR_API_KEY']
    await setSetting('model', 'remote-agent:cursor')

    const received: Array<{ threadId: string; chunk: StreamChunk }> = []
    const host: AgentHost = {
      emit: (threadId, chunk) => received.push({ threadId, chunk }),
    }
    // The remote branch never touches the registry; a bare stub is enough.
    const registry = { toLLMTools: () => [] } as unknown as ToolRegistry

    try {
      const result = await agentService.runAgent('thread-1', 'hello', [], host, registry)

      assert.ok(received.length >= 1, 'expected the agent run to emit at least one chunk')
      assert.ok(
        received.every((entry) => entry.threadId === 'thread-1'),
        'every chunk should carry the run thread id',
      )
      assert.ok(
        received.some((entry) => entry.chunk.type === 'done'),
        'the turn should terminate with a done chunk',
      )
      assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 })
    } finally {
      if (priorCursorKey !== undefined) process.env['CURSOR_API_KEY'] = priorCursorKey
    }
  })
})
