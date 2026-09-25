import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import type { LLMProvider, LLMTool, ProviderStreamChunk, StreamChunk } from '@shared/types'
import { CI_INVESTIGATOR_TOOL_NAMES } from '@copse/agent/run-subagent.ts'
import { ToolRegistry, setPermissionGateForTests } from '../tool-registry.ts'
import { runCiInvestigatorSubagent } from './ci-investigator-service.ts'
import {
  defaultMaxLlmCallsForSteps,
  EXTENSION_GRANT_LLM_CALLS,
  MAX_EXTENSION_GRANTS,
} from '@copse/agent/agent-loop-limits.ts'

/** A registry holding every allow-listed tool plus parent-only tools the subagent must never reach. */
function buildRegistry(calls: string[]): ToolRegistry {
  const registry = new ToolRegistry()
  for (const name of [...CI_INVESTIGATOR_TOOL_NAMES, 'run_shell', 'write_file', 'investigate_ci']) {
    registry.register({
      name,
      description: `fake ${name}`,
      parameters: z.looseObject({}),
      execute: async () => {
        calls.push(name)
        return `${name} ok`
      },
    })
  }
  return registry
}

function run(
  provider: LLMProvider,
  registry: ToolRegistry,
  chunks: StreamChunk[] = [],
): ReturnType<typeof runCiInvestigatorSubagent> {
  return runCiInvestigatorSubagent({
    parentToolCallId: 'parent-ci',
    prNumber: 42,
    parentGoal: 'Fix the failing CI',
    provider,
    registry,
    contextWindow: 200_000,
    toolSchemaReserve: 0,
    signal: new AbortController().signal,
    onChunk: (chunk) => chunks.push(chunk),
    usageModel: 'test-model',
  })
}

describe('runCiInvestigatorSubagent', () => {
  beforeEach(() => {
    setPermissionGateForTests(async () => true)
  })
  afterEach(() => {
    setPermissionGateForTests(null)
  })

  it('offers the subagent only the allow-listed read-only tools', async () => {
    let offered: LLMTool[] = []
    const provider: LLMProvider = {
      async *stream(_messages, tools): AsyncGenerator<ProviderStreamChunk> {
        offered = tools
        yield { type: 'text', text: 'Root cause: flaky test.' }
        yield { type: 'done' }
      },
    }
    const { summary } = await run(provider, buildRegistry([]))
    assert.equal(summary, 'Root cause: flaky test.')
    assert.deepEqual(offered.map((t) => t.name).sort(), [...CI_INVESTIGATOR_TOOL_NAMES].sort())
    for (const name of ['run_shell', 'write_file', 'investigate_ci']) {
      assert.ok(!offered.some((t) => t.name === name), `${name} must not be offered`)
    }
  })

  it('refuses a call to a tool outside the allow-list without executing it', async () => {
    const calls: string[] = []
    let streamCalls = 0
    const provider: LLMProvider = {
      async *stream(): AsyncGenerator<ProviderStreamChunk> {
        streamCalls++
        if (streamCalls === 1) {
          // A model naming a parent tool it was never offered.
          yield {
            type: 'tool_call',
            toolCall: { id: 'bad-1', name: 'run_shell', args: { command: 'echo hi' } },
          }
          yield { type: 'tool_call', toolCall: { id: 'ok-1', name: 'gh_run_view', args: {} } }
          yield { type: 'done' }
          return
        }
        yield { type: 'text', text: 'Findings.' }
        yield { type: 'done' }
      },
    }
    const chunks: StreamChunk[] = []
    await run(provider, buildRegistry(calls), chunks)
    assert.deepEqual(calls, ['gh_run_view'])
    const refused = chunks.find(
      (c) => c.type === 'subagent_tool_result' && c.toolCallId === 'bad-1',
    )
    assert.ok(refused, 'the refused call still reports a result')
    assert.equal(refused.type === 'subagent_tool_result' && refused.isError, true)
  })

  // The subagent runs on runSubagent's default 10-step budget; a run that keeps
  // making distinct progress may earn the loop's bounded adaptive extensions,
  // so its hard ceiling is the step budget's LLM-call allowance plus the grants.
  const HARD_CEILING =
    defaultMaxLlmCallsForSteps(10) + MAX_EXTENSION_GRANTS * EXTENSION_GRANT_LLM_CALLS

  function loopingProvider(args: (n: number) => Record<string, string>): {
    provider: LLMProvider
    streamCalls: () => number
  } {
    let n = 0
    return {
      provider: {
        async *stream(): AsyncGenerator<ProviderStreamChunk> {
          n++
          yield {
            type: 'tool_call',
            toolCall: { id: `loop-${String(n)}`, name: 'read_file', args: args(n) },
          }
          yield { type: 'done' }
        },
      },
      streamCalls: () => n,
    }
  }

  it('bounds a subagent that never stops calling distinct tools', async () => {
    const calls: string[] = []
    const looping = loopingProvider((n) => ({ path: `f${String(n)}.ts` }))
    const { summary } = await run(looping.provider, buildRegistry(calls))
    assert.equal(looping.streamCalls(), HARD_CEILING)
    assert.ok(calls.length <= HARD_CEILING)
    assert.equal(typeof summary, 'string')
  })

  it('ends a stuck subagent repeating one call at the base budget', async () => {
    const calls: string[] = []
    const looping = loopingProvider(() => ({ path: 'same.ts' }))
    await run(looping.provider, buildRegistry(calls))
    // Repeats earn no extension: the run ends within the base 10-step allowance.
    assert.equal(looping.streamCalls(), defaultMaxLlmCallsForSteps(10))
    assert.ok(calls.length <= 10, `ran ${String(calls.length)} tool calls`)
  })
})
