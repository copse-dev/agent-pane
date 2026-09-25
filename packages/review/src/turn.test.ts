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

it("tells every role today's date, so a past timestamp is not read as a future one", async () => {
  const scripted = new ScriptedProvider([{ type: 'text', text: 'Done.' }])
  await runTurn({
    provider: scripted,
    model: 'date-fixture',
    systemPrompt: 'Review the change.',
    userPrompt: 'Review.',
    tools: [],
    execute: () => Promise.resolve(''),
    threadId: 'date',
    turnId: 'date-1',
    maxSteps: 1,
    now: () => new Date('2026-09-25T18:00:00Z'),
  })
  const system = scripted.calls[0]?.[0]
  assert.ok(system)
  assert.equal(system.role, 'system')
  assert.match(
    typeof system.content === 'string' ? system.content : '',
    /^Review the change\.\n\nToday's date is 2026-09-25 \(UTC\)\. Dates and timestamps before it are in the past/,
  )
})
