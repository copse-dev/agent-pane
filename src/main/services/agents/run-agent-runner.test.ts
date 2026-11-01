import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { defineTool } from '@shared/types'
import { runAgentParameters, runAgentTool, runWithAgentRunner } from '../../tools/run-agent-tool.ts'
import { ToolRegistry } from '../tool-registry.ts'
import {
  buildRunAgentTask,
  prepareRunAgent,
  runPreparedAgent,
  selectRunAgentTools,
} from './run-agent-runner.ts'
import { setSetting, getSetting } from '../storage/settings.ts'
import {
  setMockScenario,
  assertMockScenarioComplete,
  clearMockScenarios,
} from '@copse/llm/mock-script.ts'

const request = runAgentParameters.parse({
  task: 'Find the selected value',
  context: 'CHILD_CONTEXT',
  tools: ['read_file'],
})
function registryWithReads(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(
    defineTool({
      name: 'read_file',
      description: 'Read fixture',
      parameters: z.object({}),
      execute: async () => 'SELECTED_VALUE',
    }),
  )
  return registry
}

describe('generic subagent', () => {
  it('validates routing vocabulary and defaults, allowing zero tools', () => {
    assert.equal(request.task_type, 'match')
    assert.equal(request.intelligence, 'match')
    assert.deepEqual(runAgentParameters.parse({ ...request, tools: [] }).tools, [])
    assert.equal(runAgentParameters.safeParse({ ...request, task_type: 'made-up' }).success, false)
    assert.equal(runAgentParameters.safeParse({ ...request, intelligence: 'gpt-5' }).success, false)
  })

  it('rejects missing, recursive, detached and read-only-incompatible tools', () => {
    const available = [
      'read_file',
      'write_file',
      'run_agent',
      'run_background',
      'send_thread_prompt',
    ].map((name) => ({ name, description: '', parameters: {} }))
    for (const name of ['missing', 'run_agent', 'run_background', 'send_thread_prompt']) {
      assert.throws(() => selectRunAgentTools(available, [name], false), /Tool unavailable/)
    }
    assert.throws(() => selectRunAgentTools(available, ['write_file'], true), /Tool unavailable/)
    assert.deepEqual(
      selectRunAgentTools(available, ['read_file', 'read_file'], true).map((tool) => tool.name),
      ['read_file'],
    )
    assert.deepEqual(selectRunAgentTools(available, [], false), [])
  })

  it('requires a scoped parent runner and keeps concurrent calls separate', async () => {
    const signal = new AbortController().signal
    await assert.rejects(async () => runAgentTool.execute(request, signal), /native parent turn/)
    const results = await Promise.all(
      ['A', 'B'].map((value) =>
        runWithAgentRunner(
          async () => value,
          async () => runAgentTool.execute(request, signal),
        ),
      ),
    )
    assert.deepEqual(results, ['A', 'B'])
  })

  it('gives prepared child providers independent conversation scopes', async () => {
    const previousMock = process.env['COPSE_PANEL_MOCK_LLM']
    const previousRoles = getSetting('roleModels', {})
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    try {
      await setSetting('roleModels', { planner: 'claude-sonnet-4-6' })
      for (const id of ['child-a', 'child-b']) {
        const childRequest = runAgentParameters.parse({
          task: id,
          context: 'Supplied context',
          tools: [],
          task_type: 'planner',
        })
        setMockScenario(id, {
          title: id,
          turns: [{ user: { includes: `Task:\n${id}` }, responses: [{ text: `Report ${id}` }] }],
        })
        const registry = registryWithReads()
        const report = await runPreparedAgent({
          request: childRequest,
          prepared: await prepareRunAgent(childRequest, registry),
          registry,
          parentToolCallId: id,
          signal: new AbortController().signal,
          onChunk: () => undefined,
        })
        assert.equal(report, `Report ${id}`)
        assertMockScenarioComplete(id)
      }
    } finally {
      clearMockScenarios()
      await setSetting('roleModels', previousRoles)
      if (previousMock === undefined) delete process.env['COPSE_PANEL_MOCK_LLM']
      else process.env['COPSE_PANEL_MOCK_LLM'] = previousMock
    }
  })

  it('runs selected tools and supplies only the explicit task/context to the provider', async () => {
    const registry = registryWithReads()
    let calls = 0
    const provider: LLMProvider = {
      async *stream(messages, tools): AsyncGenerator<ProviderStreamChunk> {
        assert.deepEqual(
          tools.map((tool) => tool.name),
          ['read_file'],
        )
        const text = JSON.stringify(messages)
        assert.ok(text.includes('CHILD_CONTEXT'))
        assert.ok(text.includes(request.task))
        assert.ok(!text.includes('PARENT_SECRET'))
        if (calls++ === 0) {
          yield { type: 'tool_call', toolCall: { id: 'read-child', name: 'read_file', args: {} } }
        } else {
          assert.ok(text.includes('SELECTED_VALUE'))
          yield { type: 'text', text: 'Found SELECTED_VALUE' }
        }
        yield { type: 'done' }
      },
    }
    const report = await runPreparedAgent({
      request,
      prepared: {
        tools: registry.toLLMTools(),
        provider,
        contextWindow: 100_000,
        route: {
          role: 'research',
          requestedIntelligence: 'match',
          intelligence: 'mid',
          model: 'fixture',
          actualIntelligence: null,
          source: 'settings',
        },
      },
      registry,
      parentToolCallId: 'parent-call',
      signal: new AbortController().signal,
      onChunk: () => undefined,
    })
    assert.equal(report, 'Found SELECTED_VALUE')
    assert.equal(calls, 2)
    assert.equal(
      buildRunAgentTask(request, '/workspace'),
      'Workspace: /workspace\n\nTask:\nFind the selected value\n\nContext supplied by parent:\nCHILD_CONTEXT',
    )
  })
})
