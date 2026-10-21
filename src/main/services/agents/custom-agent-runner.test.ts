import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import type { LLMProvider } from '@shared/types'
import { defineTool } from '@shared/types'
import type { AgentMetadata } from '@shared/types/agents.ts'
import { ToolRegistry } from '../tool-registry.ts'
import { runWithAgentRunReadonly } from '../agent-run-readonly.ts'
import { runCustomAgent, type CustomAgentRunContext } from './custom-agent-runner.ts'

const agent: AgentMetadata = {
  name: 'reader',
  description: 'Read independently',
  source: 'user',
  container: '.copse',
  agentPath: '/agents/reader.md',
  body: 'Read and report.',
  tools: null,
  disallowedTools: [],
  model: 'inherit',
  readonly: false,
  maxTurns: 2,
  color: null,
  unsupportedFields: [],
}
function context(provider: LLMProvider, registry = new ToolRegistry()): CustomAgentRunContext {
  return {
    provider,
    registry,
    parentToolCallId: 'worker',
    parentGoal: 'Inspect',
    parentModel: 'fixture',
    contextWindow: 128_000,
    toolSchemaReserve: 1_000,
    onChunk: () => undefined,
  }
}

describe('custom agent runner containment', () => {
  it('rejects requested worktree isolation before provider inference', async () => {
    let calls = 0
    const provider: LLMProvider = {
      async *stream() {
        calls++
        yield { type: 'done' }
      },
    }
    await assert.rejects(
      runCustomAgent(
        context(provider),
        {
          ...agent,
          unsupportedFields: [{ field: 'isolation', reason: 'worktree requested' }],
        },
        'inspect',
        new AbortController().signal,
      ),
      /isolation.*unavailable/,
    )
    assert.equal(calls, 0)
  })

  it('does not dispatch mutating or recursive calls even when the model invents them', async () => {
    const registry = new ToolRegistry()
    let writes = 0
    registry.register(
      defineTool({
        name: 'write_file',
        description: 'Write',
        parameters: z.object({}),
        execute: () => {
          writes++
          return 'written'
        },
      }),
    )
    let calls = 0
    const provider: LLMProvider = {
      async *stream(_messages, tools) {
        assert.ok(
          !tools.some((tool) =>
            ['write_file', 'run_shell', 'run_readonly_workers'].includes(tool.name),
          ),
        )
        if (calls++ === 0) {
          yield { type: 'tool_call', toolCall: { id: 'write', name: 'write_file', args: {} } }
          yield { type: 'done' }
        } else {
          yield { type: 'text', text: 'Read-only report.' }
          yield { type: 'done' }
        }
      },
    }
    const report = await runWithAgentRunReadonly(true, () =>
      runCustomAgent(context(provider, registry), agent, 'inspect', new AbortController().signal),
    )
    assert.equal(writes, 0)
    assert.equal(report, 'Read-only report.')
  })

  it('propagates provider failure instead of reporting a successful supervised worker', async () => {
    const provider: LLMProvider = {
      stream() {
        throw new Error('provider failed')
      },
    }
    await assert.rejects(
      runCustomAgent(context(provider), agent, 'inspect', new AbortController().signal),
      /provider failed/,
    )
  })
})
