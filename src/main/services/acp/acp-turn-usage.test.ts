import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { costForModelUsage } from '@copse/llm/estimate-cost.ts'
import { acpTurnUsage } from './acp-agent-service.ts'

/**
 * `acpTurnUsage` prefers the agent's reported usage and only estimates (~4
 * chars/token) when the agent reports nothing — flagging the estimate so the
 * usage panel can mark it approximate.
 */
describe('acpTurnUsage', () => {
  it('uses reported usage verbatim when any tokens are present', () => {
    assert.deepEqual(acpTurnUsage({ inputTokens: 4855, outputTokens: 4 }, 'prompt', 'response'), {
      inputTokens: 4855,
      outputTokens: 4,
      estimated: false,
    })
  })

  it('keeps reported counts even when one side is zero (does not estimate)', () => {
    assert.deepEqual(acpTurnUsage({ inputTokens: 0, outputTokens: 5 }, 'prompt', 'response'), {
      inputTokens: 0,
      outputTokens: 5,
      estimated: false,
    })
  })

  it('estimates from text length (~4 chars/token) when usage is absent', () => {
    // 8 chars -> 2 tokens, 12 chars -> 3 tokens.
    assert.deepEqual(acpTurnUsage(undefined, 'abcdefgh', 'abcdefghijkl'), {
      inputTokens: 2,
      outputTokens: 3,
      estimated: true,
    })
  })

  it('folds cache tokens into input, since ACP reports fresh input only (claude-agent-acp)', () => {
    // claude-agent-acp sums Anthropic `input_tokens` (fresh only) and reports
    // cache reads/writes beside it; `totalTokens` is all four added together.
    assert.deepEqual(
      acpTurnUsage(
        {
          inputTokens: 3,
          outputTokens: 120,
          cachedReadTokens: 40_000,
          cachedWriteTokens: 1_200,
          totalTokens: 41_323,
        },
        'prompt',
        'response',
      ),
      {
        inputTokens: 41_203,
        outputTokens: 120,
        cacheReadTokens: 40_000,
        cacheCreationTokens: 1_200,
        estimated: false,
      },
    )
  })

  it('folds cached reads into input for codex-acp, which reports no cache writes', () => {
    // codex-acp reports OpenAI's input minus its cached input; total stays inclusive.
    assert.deepEqual(
      acpTurnUsage(
        { inputTokens: 8_000, outputTokens: 300, cachedReadTokens: 2_000, totalTokens: 10_300 },
        'prompt',
        'response',
      ),
      { inputTokens: 10_000, outputTokens: 300, cacheReadTokens: 2_000, estimated: false },
    )
  })

  it('folds cache in when the agent omits totalTokens', () => {
    assert.deepEqual(
      acpTurnUsage(
        { inputTokens: 10, outputTokens: 5, cachedReadTokens: 90, cachedWriteTokens: null },
        'prompt',
        'response',
      ),
      { inputTokens: 100, outputTokens: 5, cacheReadTokens: 90, estimated: false },
    )
  })

  it('takes input as reported when totalTokens shows it already includes cache', () => {
    // total = input + output, so the cache is inside input: adding it would double-count.
    assert.deepEqual(
      acpTurnUsage(
        { inputTokens: 100, outputTokens: 5, cachedReadTokens: 90, totalTokens: 105 },
        'prompt',
        'response',
      ),
      { inputTokens: 100, outputTokens: 5, cacheReadTokens: 90, estimated: false },
    )
  })

  it('prices fresh ACP input instead of clamping it to zero', () => {
    const turn = acpTurnUsage(
      { inputTokens: 1_000_000, outputTokens: 0, cachedReadTokens: 1_000_000, totalTokens: 0 },
      'prompt',
      'response',
    )
    const model = 'acp:usage-test#priced'
    const cost = costForModelUsage(model, turn, {
      [model]: { inputPricePerMTok: 5, outputPricePerMTok: 25, cacheReadPricePerMTok: 0.5 },
    })
    // 1M fresh at $5 + 1M cache read at $0.50. Reported verbatim, fresh input
    // was input - cache = 0 and the turn cost only $0.50.
    assert.equal(cost, 5.5)
  })

  it('estimates when usage is present but all-zero, and rounds up partial tokens', () => {
    // 5 chars -> ceil(5/4) = 2 tokens.
    assert.deepEqual(acpTurnUsage({ inputTokens: 0, outputTokens: 0 }, 'abcde', ''), {
      inputTokens: 2,
      outputTokens: 0,
      estimated: true,
    })
  })
})
