import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ARTIFACT_CHECKPOINT_DELAY_MINUTES_SETTING,
  ARTIFACT_CHECKPOINT_HOOK_ID,
  ARTIFACT_CHECKPOINT_NUDGE,
  ARTIFACT_CHECKPOINT_PLUGIN_ID,
  DEFAULT_ARTIFACT_CHECKPOINT_DELAY_MINUTES,
  artifactCheckpointHook,
  resolveArtifactCheckpointDelayMinutes,
} from '../artifact-checkpoint.ts'
import { artifactCheckpointPlugin } from './artifact-checkpoint-plugin.ts'
import { createFirstPartyPluginRegistry, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'
import type { StepBoundaryPayload } from '../hooks/canonical-events.ts'

const boundary = (over: Partial<StepBoundaryPayload> = {}): StepBoundaryPayload => ({
  phase: 'preStream' as const,
  loopNudgeSent: false,
  forceTextAttempted: false,
  artifactCheckpointSent: false,
  artifactCheckpointEligible: true,
  elapsedWallTimeMs: 0,
  remainingWallTimeMs: 30 * 60_000,
  streamCappedAsRunaway: false,
  ...over,
})

describe('copse.artifact-checkpoint plugin', () => {
  it('ships as an experimental, default-off-by-stability hook plugin', () => {
    assert.equal(artifactCheckpointPlugin.id, ARTIFACT_CHECKPOINT_PLUGIN_ID)
    assert.equal(artifactCheckpointPlugin.manifest.stability, 'experimental')
    assert.ok(FIRST_PARTY_PLUGINS.includes(artifactCheckpointPlugin))
    assert.deepEqual(artifactCheckpointPlugin.contributions.blockingHooks, [artifactCheckpointHook])
    assert.equal(
      artifactCheckpointPlugin.manifest.storage?.namespace,
      ARTIFACT_CHECKPOINT_PLUGIN_ID,
    )
  })

  it('declares its delay setting with the policy default', () => {
    const field =
      artifactCheckpointPlugin.manifest.settings?.[ARTIFACT_CHECKPOINT_DELAY_MINUTES_SETTING]
    assert.ok(field)
    assert.equal(field.default, DEFAULT_ARTIFACT_CHECKPOINT_DELAY_MINUTES)
  })

  it('clamps corrupt and out-of-range delay values', () => {
    assert.equal(resolveArtifactCheckpointDelayMinutes(undefined), 8)
    assert.equal(resolveArtifactCheckpointDelayMinutes(0), 1)
    assert.equal(resolveArtifactCheckpointDelayMinutes(12.6), 13)
    assert.equal(resolveArtifactCheckpointDelayMinutes(10_000), 60)
  })

  it('fires at the threshold, then respects the once-per-run gate', async () => {
    const context = {
      resolvePluginSetting: (pluginId: string, key: string): number => {
        assert.equal(pluginId, ARTIFACT_CHECKPOINT_PLUGIN_ID)
        assert.equal(key, ARTIFACT_CHECKPOINT_DELAY_MINUTES_SETTING)
        return 8
      },
    }
    assert.equal(
      await artifactCheckpointHook.run(boundary({ elapsedWallTimeMs: 8 * 60_000 - 1 }), context),
      undefined,
    )
    assert.deepEqual(
      await artifactCheckpointHook.run(boundary({ elapsedWallTimeMs: 8 * 60_000 }), context),
      { injectContext: ARTIFACT_CHECKPOINT_NUDGE },
    )
    assert.equal(
      await artifactCheckpointHook.run(
        boundary({ elapsedWallTimeMs: 9 * 60_000, artifactCheckpointSent: true }),
        context,
      ),
      undefined,
    )
  })

  it('abstains when ineligible, after abort, at the hard deadline, and outside preStream', async () => {
    assert.equal(
      await artifactCheckpointHook.run(
        boundary({ elapsedWallTimeMs: 9 * 60_000, artifactCheckpointEligible: false }),
        {},
      ),
      undefined,
    )
    const controller = new AbortController()
    controller.abort()
    assert.equal(
      await artifactCheckpointHook.run(boundary({ elapsedWallTimeMs: 9 * 60_000 }), {
        signal: controller.signal,
      }),
      undefined,
    )
    assert.equal(
      await artifactCheckpointHook.run(
        boundary({ elapsedWallTimeMs: 9 * 60_000, remainingWallTimeMs: 0 }),
        {},
      ),
      undefined,
    )
    assert.equal(
      await artifactCheckpointHook.run(
        { ...boundary({ elapsedWallTimeMs: 9 * 60_000 }), phase: 'postStream' },
        {},
      ),
      undefined,
    )
  })

  it('atomically removes and restores the hook without erasing storage', () => {
    const registry = createFirstPartyPluginRegistry()
    assert.ok(
      registry.activeBlockingHooks().some((hook) => hook.id === ARTIFACT_CHECKPOINT_HOOK_ID),
    )
    registry.storage(ARTIFACT_CHECKPOINT_PLUGIN_ID).set('lastRun', 'thread-1')
    registry.disable(ARTIFACT_CHECKPOINT_PLUGIN_ID)
    assert.ok(
      !registry.activeBlockingHooks().some((hook) => hook.id === ARTIFACT_CHECKPOINT_HOOK_ID),
    )
    registry.enable(ARTIFACT_CHECKPOINT_PLUGIN_ID)
    assert.equal(registry.storage(ARTIFACT_CHECKPOINT_PLUGIN_ID).get('lastRun'), 'thread-1')
  })
})
