import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MAX_STREAM_OUTPUT_TOKENS } from '../packages/agent/src/agent-loop-limits.ts'
import { detectReasoningCircle } from '../packages/agent/src/reasoning-circle-detector.ts'
import {
  DEFAULT_SKILLSBENCH_STREAM_OUTPUT_TOKENS,
  skillsBenchReasoningCheckpointPolicy,
} from './skillsbench-agent-lib.mts'
import { skillsBenchProfile } from './lib/skillsbench-profiles.mts'

describe('SkillsBench reasoning checkpoints', () => {
  it('leaves the v1 arm on its single fixed stream cap', () => {
    const policy = skillsBenchReasoningCheckpointPolicy(
      skillsBenchProfile('skills-product@1', []),
      DEFAULT_SKILLSBENCH_STREAM_OUTPUT_TOKENS,
    )
    assert.equal(policy, undefined)
  })

  it('reassesses the v2 arm once per stream cap up to the product ceiling', () => {
    const policy = skillsBenchReasoningCheckpointPolicy(
      skillsBenchProfile('skills-product@2', []),
      DEFAULT_SKILLSBENCH_STREAM_OUTPUT_TOKENS,
    )
    assert.deepEqual(policy, {
      intervalTokens: 4_096,
      maxInitialTokens: MAX_STREAM_OUTPUT_TOKENS,
      maxRecoveryTokens: 8_192,
    })
  })

  it('keeps every checkpoint bound at or above one interval for a large cap', () => {
    const policy = skillsBenchReasoningCheckpointPolicy(
      skillsBenchProfile('skills-explicit@2', []),
      16_384,
    )
    assert.ok(policy)
    assert.ok(policy.maxInitialTokens >= policy.intervalTokens)
    assert.ok(policy.maxRecoveryTokens >= policy.intervalTokens)
    assert.ok(policy.maxRecoveryTokens <= policy.maxInitialTokens)
  })

  it('cuts a self-reported circle but not ordinary skill planning', () => {
    assert.deepEqual(detectReasoningCircle('I keep repeating myself about which skill to read.'), [
      'self_reported_circle',
    ])
    assert.deepEqual(
      detectReasoningCircle(
        'Wait, actually I need to read the offer-letter skill before writing the document.',
      ),
      [],
    )
  })
})
