import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMProvider, ModelUsage } from '@shared/types'
import type { ProviderStreamChunk } from '@shared/types/stream.ts'
import { ToolRegistry } from './tool-registry.ts'
import {
  createExploreSubagentRunner,
  type ExploreSubagentRunner,
  type ExploreSubagentRunnerContext,
} from './explore-subagent-runner.ts'
import type { RunExploreSubagentOptions } from './subagent-service.ts'
import { ToolCircuitBreaker } from './tool-circuit-breaker.ts'

function provider(): LLMProvider {
  return {
    async *stream(): AsyncGenerator<ProviderStreamChunk> {
      yield { type: 'done' as const }
    },
  }
}

const LOCAL = 'lmstudio:qwen/qwen3.6-35b-a3b'
const PARENT = 'gpt-5.5'

function context(
  localProvider: LLMProvider,
  parentProvider: LLMProvider,
): ExploreSubagentRunnerContext {
  const ctx: ExploreSubagentRunnerContext = {
    parentToolCallId: 'call-1',
    parentGoal: 'Fix the bug',
    provider: localProvider,
    registry: new ToolRegistry(),
    contextWindow: 32_000,
    toolSchemaReserve: 2_500,
    onChunk: () => {},
    usageModel: LOCAL,
    route: {
      threadId: 't1',
      selection: LOCAL,
      localServer: true,
      fallback: {
        provider: parentProvider,
        contextWindow: 400_000,
        toolSchemaReserve: 1_000,
        usageModel: PARENT,
      },
    },
  }
  return ctx
}

describe('explore runner circuit breaker', () => {
  it('re-runs on the parent model once LM Studio is unreachable, and trips the route', async () => {
    const local = provider()
    const parent = provider()
    const calls: RunExploreSubagentOptions[] = []
    const usage: ModelUsage = { inputTokens: 10, outputTokens: 1 }
    const breaker = new ToolCircuitBreaker()
    const chargedModels: string[] = []
    const run = createExploreSubagentRunner(context(local, parent), {
      breaker,
      addUsage: (model) => {
        chargedModels.push(model)
      },
      run: (options) => {
        calls.push(options)
        return Promise.resolve(
          options.provider === local
            ? {
                summary: 'Subagent error: Connection error.',
                text: 'Subagent error: Connection error.',
                usage,
                error: 'Connection error.',
              }
            : { summary: 'Found it in src/a.ts', text: 'Found it in src/a.ts\n\nexcerpts', usage },
        )
      },
    })

    const result = await run({ query: 'where is X?', signal: new AbortController().signal })

    assert.equal(calls.length, 2)
    const [, retry] = calls
    assert.ok(retry)
    assert.equal(retry.provider, parent)
    assert.equal(retry.usageModel, PARENT)
    assert.equal(retry.localFallback, true)
    // Each attempt is charged to the model that actually ran it.
    assert.deepEqual(chargedModels, [LOCAL, PARENT])
    // `text` is what the explore tool hands the parent model.
    assert.match(result.text, /is LM Studio running/)
    assert.match(result.text, /Found it in src\/a\.ts\n\nexcerpts$/)
    assert.match(result.summary, /Found it in src\/a\.ts$/)
    // The turn builder reads this to skip the route for the rest of the thread.
    assert.notEqual(breaker.get('t1', 'explore', LOCAL), null)
  })

  it('sends later calls in the tripping turn straight to the parent model', async () => {
    const local = provider()
    const parent = provider()
    const breaker = new ToolCircuitBreaker()
    const ran: string[] = []
    const chargedModels: string[] = []
    // Each `explore` call in a turn gets its own runner over the same route.
    const runner = (): ExploreSubagentRunner =>
      createExploreSubagentRunner(context(local, parent), {
        breaker,
        addUsage: (model) => {
          chargedModels.push(model)
        },
        run: (options) => {
          ran.push(options.provider === local ? 'routed' : 'parent')
          return Promise.resolve(
            options.provider === local
              ? {
                  summary: 'Subagent error: Connection error.',
                  text: 'Subagent error: Connection error.',
                  usage: { inputTokens: 0, outputTokens: 0 },
                  error: 'Connection error.',
                }
              : {
                  summary: 'Found it',
                  text: 'Found it',
                  usage: { inputTokens: 5, outputTokens: 1 },
                },
          )
        },
      })

    await runner()({ query: 'first', signal: new AbortController().signal })
    assert.deepEqual(ran, ['routed', 'parent'])
    ran.length = 0
    chargedModels.length = 0

    const later = await runner()({ query: 'second', signal: new AbortController().signal })
    assert.deepEqual(ran, ['parent'], 'the tripped route is not tried again')
    assert.deepEqual(chargedModels, [PARENT])
    assert.match(later.text, /is LM Studio running/)
    assert.match(later.text, /Underlying error: Connection error\./)
    assert.match(later.text, /Found it$/)
    assert.deepEqual(later.usage, { inputTokens: 5, outputTokens: 1 })
  })

  it('returns a transient routed failure as-is without falling back', async () => {
    const calls: RunExploreSubagentOptions[] = []
    const breaker = new ToolCircuitBreaker()
    const run = createExploreSubagentRunner(context(provider(), provider()), {
      breaker,
      addUsage: () => {},
      run: (options) => {
        calls.push(options)
        return Promise.resolve({
          summary: 'Subagent error: 503 Service Unavailable',
          text: 'Subagent error: 503 Service Unavailable',
          usage: { inputTokens: 0, outputTokens: 0 },
          error: '503 Service Unavailable',
        })
      },
    })
    const result = await run({ query: 'q', signal: new AbortController().signal })
    assert.equal(calls.length, 1)
    assert.equal(result.text, 'Subagent error: 503 Service Unavailable')
    assert.equal(breaker.get('t1', 'explore', LOCAL), null)
  })
})
