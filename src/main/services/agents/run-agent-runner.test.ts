import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it } from 'node:test'
import { z } from 'zod'
import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { defineTool } from '@shared/types'
import { runAgentParameters, runAgentTool, runWithAgentRunner } from '../../tools/run-agent-tool.ts'
import { ToolRegistry, setPermissionGateForTests } from '../tool-registry.ts'
import {
  buildRunAgentTask,
  prepareRunAgent,
  runPreparedAgent,
  selectRunAgentTools,
} from './run-agent-runner.ts'
import { setSetting, getSetting } from '../storage/settings.ts'
import { getAgentRunTodos, runWithAgentRunTodoContext } from '../agent-run-todos.ts'
import { updateTodosTool } from '../../tools/todo-tool.ts'
import { trackLongTaskTool } from '../../tools/long-task-tool.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import { runWithWorkspaceTrust } from '../security/workspace-trust.ts'
import { createFirstPartyPluginRegistry } from '@copse/agent/plugins/first-party-plugins.ts'
import { runWithDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
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
      'update_todos',
      'track_long_task',
      'subthreads',
    ].map((name) => ({ name, description: '', parameters: {} }))
    for (const name of [
      'missing',
      'run_agent',
      'run_background',
      'send_thread_prompt',
      'update_todos',
      'track_long_task',
      'subthreads',
    ]) {
      assert.throws(() => selectRunAgentTools(available, [name], false), /Tool unavailable/)
    }
    assert.throws(() => selectRunAgentTools(available, ['write_file'], true), /Tool unavailable/)
    assert.deepEqual(
      selectRunAgentTools(available, ['read_file', 'read_file'], true).map((tool) => tool.name),
      ['read_file'],
    )
    assert.deepEqual(selectRunAgentTools(available, [], false), [])
  })

  it('rejects real parent-plan and continuation tools during preflight', async () => {
    const registry = registryWithReads()
    registry.register(updateTodosTool)
    registry.register(trackLongTaskTool)
    for (const tool of [updateTodosTool, trackLongTaskTool]) {
      await assert.rejects(
        prepareRunAgent({ ...request, tools: ['read_file', tool.name] }, registry),
        /Tool unavailable.*No worker was started/,
      )
    }
  })

  it('revalidates prepared tools before a child can mutate or delegate through the parent plan', async () => {
    const registry = registryWithReads()
    registry.register(updateTodosTool)
    let providerCalls = 0
    let parentUpdates = 0
    let routedWorkers = 0
    const provider: LLMProvider = {
      async *stream(): AsyncGenerator<ProviderStreamChunk> {
        if (providerCalls++ === 0) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: 'replace-parent-plan',
              name: 'update_todos',
              args: {
                todos: [{ content: 'Child work', status: 'in_progress', assignedModel: 'local' }],
              },
            },
          }
        } else {
          yield { type: 'text', text: 'Finished' }
        }
        yield { type: 'done' }
      },
    }
    await runWithAgentRunTodoContext(
      {
        initial: [{ id: 'parent-plan', content: 'Parent work', status: 'in_progress' }],
        onUpdate: () => {
          parentUpdates += 1
        },
        postProcess: async (_before, todos) => {
          routedWorkers += 1
          return { todos }
        },
      },
      async () => {
        await assert.rejects(
          runPreparedAgent({
            request: { ...request, tools: ['update_todos'] },
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
          }),
          /Tool unavailable/,
        )
        assert.deepEqual(getAgentRunTodos(), [
          { id: 'parent-plan', content: 'Parent work', status: 'in_progress' },
        ])
      },
    )
    assert.equal(providerCalls, 0)
    assert.equal(parentUpdates, 0)
    assert.equal(routedWorkers, 0)
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

  it('defers every same-response edit until the child receives its scoped instructions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copse-child-instructions-'))
    let writes = 0
    let calls = 0
    const registry = new ToolRegistry()
    registry.register(
      defineTool({
        name: 'write_file',
        description: 'Write the fixture',
        parameters: z.object({ path: z.string(), content: z.string() }),
        execute: () => {
          writes += 1
          return 'Wrote the requested file'
        },
      }),
    )
    const childRequest = { ...request, tools: ['write_file'] }
    const provider: LLMProvider = {
      async *stream(messages): AsyncGenerator<ProviderStreamChunk> {
        const text = JSON.stringify(messages)
        if (calls === 1) {
          assert.equal(writes, 0, 'the first edit must wait for its directory instructions')
          assert.match(text, /NESTED_CHILD_GUIDANCE/)
          assert.match(text, /trust=\\"untrusted\\"/)
        }
        if (calls++ < 2) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: `child-edit-${String(calls)}`,
              name: 'write_file',
              args: { path: 'nested/file.txt', content: 'updated' },
            },
          }
          if (calls === 1) {
            yield {
              type: 'tool_call',
              toolCall: {
                id: 'child-edit-in-same-response',
                name: 'write_file',
                args: { path: 'nested/another.txt', content: 'also updated' },
              },
            }
          }
        } else {
          assert.equal(writes, 1)
          assert.match(text, /ROOT_CHILD_GUIDANCE/)
          yield { type: 'text', text: 'Edited after reading the instructions' }
        }
        yield { type: 'done' }
      },
    }
    try {
      await mkdir(join(root, 'nested'))
      await writeFile(join(root, 'AGENTS.md'), 'ROOT_CHILD_GUIDANCE')
      await writeFile(join(root, 'nested/AGENTS.md'), 'NESTED_CHILD_GUIDANCE')
      setPermissionGateForTests(async () => true)
      const report = await runWithThreadExecutionContext(
        {
          projectId: 'child-instructions-project',
          threadId: 'parent-thread',
          projectRoot: root,
          root,
          checkoutMode: 'shared',
          branch: null,
        },
        () =>
          runWithWorkspaceTrust(root, true, () =>
            runWithDefaultPluginRegistry(createFirstPartyPluginRegistry(), () =>
              runPreparedAgent({
                request: childRequest,
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
                parentToolCallId: 'child-instructions',
                signal: new AbortController().signal,
                onChunk: () => undefined,
              }),
            ),
          ),
      )
      assert.equal(report, 'Edited after reading the instructions')
      assert.equal(writes, 1)
    } finally {
      setPermissionGateForTests(null)
      await rm(root, { recursive: true, force: true })
    }
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
