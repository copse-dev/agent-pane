import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MAX_STREAM_OUTPUT_TOKENS } from '@copse/agent/agent-loop-limits.ts'
import {
  PRODUCT_REASONING_CHECKPOINT_INTERVAL_TOKENS,
  PRODUCT_REASONING_CHECKPOINT_POLICY,
  PRODUCT_REASONING_CHECKPOINT_TEXT_TOLERANCE_CHARS,
  PRODUCT_REASONING_RECOVERY_MAX_TOKENS,
} from '@copse/agent/reasoning-checkpoint-policy.ts'
import { DEFAULT_REASONING_CIRCLE_DETECTOR_OPTIONS } from '@copse/agent/reasoning-circle-detector.ts'
import {
  TERMINAL_BENCH_PROFILE_VERSIONED_IDS,
  parseRunnableTerminalBenchProfileIds,
  parseTerminalBenchProfileIds,
  runnableTerminalBenchProfile,
  terminalBenchProfile,
  terminalBenchStreamCapOverrides,
  type TerminalBenchProfileVersionedId,
} from './terminal-bench-profiles.mts'

/**
 * Every profile version's content hash, frozen. Retained capsules, run
 * manifests and comparison reports identify behaviour by these values, so a
 * hash may never change under an existing id.
 *
 * If this test fails, something a profile's hash covers changed. Do not edit
 * the expected value: restore the old definition and add a new version
 * (`product-aligned@5`, …) carrying the change, then pin its hash here.
 */
const PINNED_PROFILE_HASHES: Record<TerminalBenchProfileVersionedId, string> = {
  'main-legacy@1': '4c79ddf0b404ea906d6b136fcc874253c5353ca4987e6d5fc5f8910ce67db65b',
  'pr-1149@1': '9f482024cb1d5ad879e285f96dd1c73f8ae7c57ae48fcab8476d79598aa0a460',
  'product-aligned@1': '9880c6ed0d8fac7b93eb5a8d842ce813ae1aeaa430110dc2eb394ab482774aaa',
  'product-aligned@2': 'bb72d92ff108556d25660492cdf6bfd0e165b45db13aebcfb9d1e3132461dd23',
  'product-aligned@3': '69c56451ed7d3abb564ac6edf731294cbf70d8c496249336f9282dbd64181a1f',
  'product-aligned@4': '252de9d8b6a79e859f62bd2355edf71ccf76673f27628a7f25d3fdb7c6f0dc7d',
}

const DRIFT_HINT =
  'A product constant this Terminal-Bench profile depends on changed. Keep the existing ' +
  'profile version as it is, add a new product-aligned version whose loop settings match the ' +
  'product, point CURRENT_PROFILE_VERSIONS at it, and pin its hash.'

describe('Terminal-Bench profile provenance', () => {
  it('never changes the hash of an existing profile version', () => {
    for (const versionedId of TERMINAL_BENCH_PROFILE_VERSIONED_IDS) {
      const profile = terminalBenchProfile(versionedId)
      assert.equal(profile.versionedId, versionedId)
      assert.equal(profile.contentHash, PINNED_PROFILE_HASHES[versionedId], versionedId)
    }
    const hashes = Object.values(PINNED_PROFILE_HASHES)
    assert.equal(new Set(hashes).size, hashes.length)
  })

  it('keeps the current product-aligned version in step with the product', () => {
    const profile = terminalBenchProfile('product-aligned')
    assert.equal(profile.retirement, null)
    assert.deepEqual(
      profile.loop.reasoningCheckpointPolicy,
      {
        ...PRODUCT_REASONING_CHECKPOINT_POLICY,
        // Terminal-Bench keeps its action-oriented 2K visible-answer ceiling.
        maxNonReasoningTokens: PRODUCT_REASONING_CHECKPOINT_INTERVAL_TOKENS,
      },
      DRIFT_HINT,
    )
    assert.equal(profile.loop.maxStreamOutputTokens, PRODUCT_REASONING_CHECKPOINT_INTERVAL_TOKENS)
    assert.equal(
      profile.loop.reasoningRunawayRecoveryOutputTokens,
      PRODUCT_REASONING_RECOVERY_MAX_TOKENS,
      DRIFT_HINT,
    )
    assert.equal(
      profile.loop.reasoningRunawayTextToleranceChars,
      PRODUCT_REASONING_CHECKPOINT_TEXT_TOLERANCE_CHARS,
      DRIFT_HINT,
    )
    assert.equal(profile.loop.reasoningCheckpointPolicy.maxInitialTokens, MAX_STREAM_OUTPUT_TOKENS)
  })

  it('runs no profile against circle-detector thresholds it was not defined with', () => {
    // runAgentLoop always uses the product's detector thresholds, so the host
    // cannot pin a profile's own. A runnable profile whose recorded thresholds
    // differ would run under a hash that does not describe it.
    for (const versionedId of TERMINAL_BENCH_PROFILE_VERSIONED_IDS) {
      const profile = terminalBenchProfile(versionedId)
      if (profile.retirement !== null || profile.loop.reasoningCircleDetector === null) continue
      assert.deepEqual(
        profile.loop.reasoningCircleDetector,
        DEFAULT_REASONING_CIRCLE_DETECTOR_OPTIONS,
        `${versionedId}: retire it and add a new version. ${DRIFT_HINT}`,
      )
    }
    // Only checkpointed profiles run the detector at all.
    for (const versionedId of TERMINAL_BENCH_PROFILE_VERSIONED_IDS) {
      const { loop } = terminalBenchProfile(versionedId)
      assert.equal(loop.reasoningCircleDetector === null, loop.reasoningCheckpointPolicy === null)
    }
  })

  it('keeps v4 behaviourally identical to v3 immediately before v3 was retired', () => {
    const v3 = terminalBenchProfile('product-aligned@3')
    const v4 = terminalBenchProfile('product-aligned@4')
    const {
      contentHash: _v3Hash,
      version: _v3,
      versionedId: _v3Id,
      retirement: _r3,
      ...v3Rest
    } = v3
    const {
      contentHash: _v4Hash,
      version: _v4,
      versionedId: _v4Id,
      retirement: _r4,
      ...v4Rest
    } = v4
    assert.deepEqual(v4Rest, v3Rest)
  })

  it('resolves retired profiles for history but refuses to run them', () => {
    assert.equal(terminalBenchProfile('product-aligned@3').versionedId, 'product-aligned@3')
    assert.deepEqual(parseTerminalBenchProfileIds('product-aligned@3'), ['product-aligned@3'])
    assert.throws(() => runnableTerminalBenchProfile('product-aligned@3'), /product-aligned@4/)
    assert.throws(
      () => parseRunnableTerminalBenchProfileIds('main-legacy,product-aligned@3'),
      /product-aligned@4/,
    )
    assert.deepEqual(parseRunnableTerminalBenchProfileIds('main-legacy@1,product-aligned'), [
      'main-legacy@1',
      'product-aligned',
    ])
    assert.equal(runnableTerminalBenchProfile('product-aligned').versionedId, 'product-aligned@4')
  })

  it('reports only the stream caps a run changed from its profile', () => {
    const profile = terminalBenchProfile('product-aligned@4')
    assert.deepEqual(
      terminalBenchStreamCapOverrides(profile, {
        maxStreamOutputTokens: 2_048,
        reasoningRunawayRecoveryOutputTokens: 4_096,
      }),
      {},
    )
    assert.deepEqual(
      terminalBenchStreamCapOverrides(profile, {
        maxStreamOutputTokens: 8_192,
        reasoningRunawayRecoveryOutputTokens: 4_096,
      }),
      { maxStreamOutputTokens: 8_192 },
    )
    assert.deepEqual(
      terminalBenchStreamCapOverrides(terminalBenchProfile('main-legacy@1'), {
        maxStreamOutputTokens: 2_048,
        reasoningRunawayRecoveryOutputTokens: 1_024,
      }),
      { reasoningRunawayRecoveryOutputTokens: 1_024 },
    )
  })
})
