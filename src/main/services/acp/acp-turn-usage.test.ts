import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
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

  it('estimates when usage is present but all-zero, and rounds up partial tokens', () => {
    // 5 chars -> ceil(5/4) = 2 tokens.
    assert.deepEqual(acpTurnUsage({ inputTokens: 0, outputTokens: 0 }, 'abcde', ''), {
      inputTokens: 2,
      outputTokens: 0,
      estimated: true,
    })
  })
})
