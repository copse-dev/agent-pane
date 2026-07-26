import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_STREAM_OUTPUT_TOKENS } from './agent-loop-limits.ts'
import {
  PRODUCT_REASONING_CHECKPOINT_INTERVAL_TOKENS,
  PRODUCT_REASONING_CHECKPOINT_POLICY,
  PRODUCT_REASONING_CHECKPOINT_TEXT_TOLERANCE_CHARS,
  PRODUCT_REASONING_RECOVERY_MAX_TOKENS,
} from './reasoning-checkpoint-policy.ts'

describe('product reasoning checkpoint policy', () => {
  it('pins 2K checkpoints inside the existing product ceiling', () => {
    assert.equal(PRODUCT_REASONING_CHECKPOINT_INTERVAL_TOKENS, 2_048)
    assert.equal(PRODUCT_REASONING_RECOVERY_MAX_TOKENS, 4_096)
    assert.equal(PRODUCT_REASONING_CHECKPOINT_TEXT_TOLERANCE_CHARS, 256)
    assert.deepEqual(PRODUCT_REASONING_CHECKPOINT_POLICY, {
      intervalTokens: 2_048,
      maxNonReasoningTokens: MAX_STREAM_OUTPUT_TOKENS,
      maxInitialTokens: MAX_STREAM_OUTPUT_TOKENS,
      maxRecoveryTokens: 4_096,
    })
  })
})
