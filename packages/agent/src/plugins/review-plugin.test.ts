// Contract test: the `copse.review` first-party plugin (Copse Reviewer's app
// shell, docs/plans/copse-reviewer.md Phase 3), which replaced the P5-era
// `copse.model-comparison` plugin.
//
// Pinned here:
// 1. **The plugin is registered** in `FIRST_PARTY_PLUGINS` with id
//    `copse.review`, trust `first-party`, and declares the `review_changes`
//    native tool in both its manifest and its runtime contributions.
// 2. **The retired plugin is gone.** No shipped plugin carries the old id or
//    the `compare_models` tool, so the host migration in `plugin-service.ts`
//    is the only thing that still knows the old name.
// 3. **Atomicity of disable.** One flag flip drops the tool and the bubble from
//    the active sets; plugin storage survives the disable (decision 17).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  reviewPlugin,
  CHALLENGER_MODEL_SETTING_ID,
  DEFAULT_CHALLENGER_MODEL_ID,
  DEFAULT_REVIEW_LENS_CHOICE,
  RETIRED_MODEL_COMPARISON_PLUGIN_ID,
  REVIEW_FOLLOW_UP_ID,
  REVIEW_LENSES_SETTING_ID,
  REVIEW_LENS_CHOICES,
  REVIEW_PLUGIN_ID,
  REVIEW_TOOL_NAME,
  REVIEW_VERIFY_SETTING_ID,
  REVIEWER_MODEL_SETTING_ID,
} from './review-plugin.ts'
import { createFirstPartyPluginRegistry, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'
import { BEST_INTELLECT_MODEL_SELECTOR } from '@copse/llm/dynamic-model.ts'

describe('copse.review plugin', () => {
  it('is registered in FIRST_PARTY_PLUGINS with id copse.review, experimental', () => {
    assert.equal(reviewPlugin.id, REVIEW_PLUGIN_ID)
    assert.equal(reviewPlugin.trust, 'first-party')
    assert.equal(reviewPlugin.manifest.stability, 'experimental')
    assert.ok(
      FIRST_PARTY_PLUGINS.some((plugin) => plugin.id === REVIEW_PLUGIN_ID),
      'review plugin must be part of the shipped first-party plugin list',
    )
  })

  it('has replaced the model-comparison plugin outright', () => {
    assert.ok(
      !FIRST_PARTY_PLUGINS.some((plugin) => plugin.id === RETIRED_MODEL_COMPARISON_PLUGIN_ID),
    )
    const tools = FIRST_PARTY_PLUGINS.flatMap((plugin) => plugin.contributions.toolNames)
    assert.ok(!tools.includes('compare_models'))
    assert.equal(tools.filter((name) => name === REVIEW_TOOL_NAME).length, 1)
  })

  it('declares the review_changes tool, namespaced storage, and no hook contributions', () => {
    assert.deepEqual(reviewPlugin.manifest.tools?.native, [REVIEW_TOOL_NAME])
    assert.deepEqual(reviewPlugin.manifest.storage, { namespace: REVIEW_PLUGIN_ID })
    assert.deepEqual(reviewPlugin.contributions.toolNames, [REVIEW_TOOL_NAME])
    // The review is an on-demand run (a tool, a bubble, a button), never a
    // turn-boundary hook: nothing here may fire on its own after a turn.
    assert.deepEqual(reviewPlugin.contributions.blockingHooks, [])
    assert.deepEqual(reviewPlugin.contributions.asyncHooks, [])
    assert.deepEqual(reviewPlugin.contributions.promptBlocks, [])
    assert.deepEqual(reviewPlugin.contributions.uiContributions, [])
  })

  it('suggests the review as a bubble, gated on there being a diff to review', () => {
    const [bubble, ...rest] = reviewPlugin.contributions.followUps
    assert.deepEqual(rest, [])
    assert.ok(bubble)
    assert.equal(bubble.id, REVIEW_FOLLOW_UP_ID)
    assert.equal(bubble.action, 'review')
    assert.equal(bubble.when, 'workspace-changes')
    assert.equal(bubble.prompt, undefined)
    assert.deepEqual(reviewPlugin.manifest.followUps, [bubble])
  })

  it('owns the reviewer and challenger as plugin-scoped `model` settings, plus lenses and verify', () => {
    const settings = reviewPlugin.manifest.settings
    assert.ok(settings)
    const reviewer = settings[REVIEWER_MODEL_SETTING_ID]
    assert.ok(reviewer)
    assert.equal(reviewer.kind, 'model')
    // Blank means the chat model, which no rule can express.
    assert.equal(reviewer.default, undefined)
    const challenger = settings[CHALLENGER_MODEL_SETTING_ID]
    assert.ok(challenger)
    assert.equal(challenger.kind, 'model')
    assert.equal(challenger.default, DEFAULT_CHALLENGER_MODEL_ID)
    assert.equal(DEFAULT_CHALLENGER_MODEL_ID, BEST_INTELLECT_MODEL_SELECTOR)
    const lenses = settings[REVIEW_LENSES_SETTING_ID]
    assert.ok(lenses)
    assert.equal(lenses.kind, 'enum')
    assert.deepEqual(lenses.options, [...REVIEW_LENS_CHOICES])
    assert.equal(lenses.default, DEFAULT_REVIEW_LENS_CHOICE)
    const verify = settings[REVIEW_VERIFY_SETTING_ID]
    assert.ok(verify)
    assert.equal(verify.kind, 'boolean')
    assert.equal(verify.default, true)
    for (const [id, field] of Object.entries(settings)) {
      assert.doesNotMatch(field.description ?? '', /claude-|gpt-/, `${id} names a model id`)
    }
  })

  it('atomically drops the tool and the bubble from the active seed on disable', () => {
    const registry = createFirstPartyPluginRegistry()
    const bubbleIds = (): string[] => registry.activeFollowUps().map(({ followUp }) => followUp.id)
    assert.equal(registry.isEnabled(REVIEW_PLUGIN_ID), true)
    assert.ok(registry.activeToolNames().includes(REVIEW_TOOL_NAME))
    assert.ok(bubbleIds().includes(REVIEW_FOLLOW_UP_ID))

    registry.storage(REVIEW_PLUGIN_ID).set('lastReview', 'r-1')
    registry.disable(REVIEW_PLUGIN_ID)
    assert.equal(registry.isEnabled(REVIEW_PLUGIN_ID), false)
    assert.ok(!registry.activeToolNames().includes(REVIEW_TOOL_NAME))
    assert.ok(!bubbleIds().includes(REVIEW_FOLLOW_UP_ID))

    registry.enable(REVIEW_PLUGIN_ID)
    assert.ok(registry.activeToolNames().includes(REVIEW_TOOL_NAME))
    assert.equal(registry.storage(REVIEW_PLUGIN_ID).get('lastReview'), 'r-1')
  })
})
