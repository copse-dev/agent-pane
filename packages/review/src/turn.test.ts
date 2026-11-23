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

it("trims its oldest investigation steps to the model's context, keeping the review request", async () => {
  const steps = [
    ...Array.from({ length: 6 }, (_, i) => ({
      type: 'tool_call' as const,
      name: 'read',
      args: { part: i },
    })),
    { type: 'text' as const, text: 'Done.' },
  ]
  const turn = async (contextTokens?: number): Promise<ScriptedProvider> => {
    const scripted = new ScriptedProvider(steps)
    // Reports each request's real size, as a local server does; the loop
    // trusts a measured size over its own estimate.
    let lastUsage = { inputTokens: 0, outputTokens: 0 }
    const provider = {
      get lastUsage(): { inputTokens: number; outputTokens: number } {
        return lastUsage
      },
      stream(
        ...args: Parameters<ScriptedProvider['stream']>
      ): ReturnType<ScriptedProvider['stream']> {
        lastUsage = { inputTokens: Math.round(JSON.stringify(args[0]).length / 4), outputTokens: 0 }
        return scripted.stream(...args)
      },
    }
    const result = await runTurn({
      provider,
      model: 'context-fixture',
      systemPrompt: 'Review the change.',
      userPrompt: 'Review this diff.',
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }],
      // About 5,000 tokens per result: six of them overflow a 16k window.
      execute: (_name, args) => Promise.resolve(`${JSON.stringify(args)} ${'x'.repeat(20_000)}`),
      threadId: 'context',
      turnId: 'context-1',
      maxSteps: 8,
      ...(contextTokens === undefined ? {} : { contextTokens }),
    })
    assert.equal(result.outcome, 'completed')
    return scripted
  }
  const requestSizes = (scripted: ScriptedProvider): number[] =>
    scripted.calls.map((call) => Math.round(JSON.stringify(call).length / 4))
  const lastRequest = (scripted: ScriptedProvider): string =>
    JSON.stringify(scripted.calls.at(-1) ?? [])

  // Without a known window every step is resent, as before.
  assert.match(lastRequest(await turn()), /\\"part\\":0/)
  const trimmed = await turn(16_000)
  assert.match(lastRequest(trimmed), /Review this diff\./)
  // Later steps still ran and reached the model; only the oldest were dropped.
  assert.ok(trimmed.calls.some((call) => JSON.stringify(call).includes('\\"part\\":4')))
  assert.doesNotMatch(lastRequest(trimmed), /\\"part\\":0/)
  // No request the server receives outgrows the window, so it never cuts one.
  assert.ok(Math.max(...requestSizes(trimmed)) <= 16_000, String(requestSizes(trimmed)))
})
