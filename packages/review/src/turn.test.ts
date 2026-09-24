import { it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'
import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { ScriptedProvider } from './scripted-provider.ts'
import { runTurn } from './turn.ts'

it('separates tool wall time from model waits in a real review turn', async () => {
  const scripted = new ScriptedProvider([
    { type: 'tool_call', name: 'probe', args: {} },
    { type: 'text', text: 'Done.' },
  ])
  const provider: LLMProvider = {
    async *stream(...args): AsyncGenerator<ProviderStreamChunk> {
      await setTimeout(20)
      yield* scripted.stream(...args)
    },
  }
  const result = await runTurn({
    provider,
    model: 'timing-fixture',
    systemPrompt: 'Run the probe.',
    userPrompt: 'Review.',
    tools: [
      { name: 'probe', description: 'Probe', parameters: { type: 'object', properties: {} } },
    ],
    execute: async () => {
      await setTimeout(20)
      return 'checked'
    },
    threadId: 'timing',
    turnId: 'timing-1',
    maxSteps: 3,
  })
  assert.equal(result.outcome, 'completed')
  assert.ok(result.timing.toolMs >= 10)
  assert.ok(result.timing.modelAndOverheadMs >= 20)
  assert.equal(result.timing.durationMs, result.timing.toolMs + result.timing.modelAndOverheadMs)
})
