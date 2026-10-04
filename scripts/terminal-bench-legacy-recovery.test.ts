import assert from 'node:assert/strict'
import { it } from 'node:test'
import { REASONING_RUNAWAY_GIVEUP_MESSAGE } from '@copse/llm/provider-stop-reason.ts'
import { runAgentLoop } from '@copse/agent/run-agent-loop.ts'
import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import type { AgentStreamChunk } from '@copse/agent/wire-types.ts'
import { terminalBenchProfile } from './lib/terminal-bench-profiles.mts'
import {
  terminalBenchLoopOptions,
  terminalBenchRuntimeConfiguration,
} from './terminal-bench-agent-lib.mts'

for (const id of [
  'main-legacy',
  'pr-1149',
  'product-aligned@1',
  'product-aligned@2',
  'product-aligned@5',
]) {
  it(`preserves two-cut recovery without a third suppressed stream for ${id}`, async () => {
    let streams = 0
    const provider: LLMProvider = {
      async *stream(): AsyncGenerator<ProviderStreamChunk> {
        streams++
        for (let index = 0; index < 100; index++)
          yield { type: 'reasoning', text: 'reasoning '.repeat(1000) }
        yield { type: 'done' }
      },
    }
    const profile = terminalBenchProfile(id)
    // Pin the immutable profile baseline, without the reported soft-budget override.
    const runtime = terminalBenchRuntimeConfiguration(profile, {
      COPSE_TERMINAL_REASONING_SOFT_BUDGET_TOKENS: '0',
    })
    const options = terminalBenchLoopOptions(profile, runtime, 'inspect the source')
    assert.equal(options.reasoningRunawayRecoveryStrategy, 'legacy-two-cut-v1')
    const chunks: AgentStreamChunk[] = []
    await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'inspect the source' }],
      tools: [],
      ...options,
      onChunk: (chunk) => chunks.push(chunk),
      executeTool: async () => 'ok',
    })
    assert.equal(streams, 2)
    assert.deepEqual(chunks.at(-1), { type: 'done' })
    assert.ok(
      chunks.some(
        (chunk) => chunk.type === 'text' && chunk.text === REASONING_RUNAWAY_GIVEUP_MESSAGE,
      ),
    )
  })
}
