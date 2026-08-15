// Contract test: the `copse.model-comparison` first-party plugin (P5).
//
// P5 landing invariants pinned here (docs/plans/hooks-and-feature-packs.md,
// P5 row + "Feature plugins" section). Together they prove:
//
// 1. **The plugin is registered** in `FIRST_PARTY_PLUGINS` with id
//    `copse.model-comparison` and trust `first-party`, and its manifest +
//    contributions declare the `compare_models` native tool.
// 2. **No double-registration.** Historically the tool was gated by the
//    top-level `MODEL_COMPARISON_ENABLED_SETTING` boolean, which is deleted in
//    the same change (`registry-bootstrap.ts` no longer imports it; the
//    `settings-writable.ts` schema no longer accepts it) — the plugin registry
//    is the single source of truth. This test scans the shipped seed and
//    asserts `compare_models` appears exactly once in
//    `activeToolNames()` (i.e. only the plugin contributes it), and that no
//    async/blocking hooks are contributed twice under this plugin id.
// 3. **Atomicity of disable.** One flag flip drops the tool from
//    `activeToolNames()`; the host tool-registry sync
//    (`syncModelComparisonTools` in `registry-bootstrap.ts`) reads the same
//    plugin registry and unregisters the concrete tool object on toggle. Plugin
//    storage survives the disable (decision 17).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  modelComparisonPlugin,
  MODEL_COMPARISON_PLUGIN_ID,
  MODEL_COMPARISON_TOOL_NAME,
  MODEL_COMPARISON_FOLLOW_UP_ID,
  COMPARISON_MODEL_A_SETTING_ID,
  COMPARISON_MODEL_B_SETTING_ID,
  COMPARISON_JUDGE_MODEL_SETTING_ID,
  DEFAULT_COMPARISON_MODEL_ID,
} from './model-comparison-plugin.ts'
import { createFirstPartyPluginRegistry, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'
import { BEST_INTELLECT_MODEL_SELECTOR } from '@copse/llm/dynamic-model.ts'

describe('copse.model-comparison plugin (P5)', () => {
  it('is registered in FIRST_PARTY_PLUGINS with id copse.model-comparison', () => {
    assert.equal(modelComparisonPlugin.id, MODEL_COMPARISON_PLUGIN_ID)
    assert.equal(modelComparisonPlugin.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PLUGINS.some((plugin) => plugin.id === MODEL_COMPARISON_PLUGIN_ID),
      'model-comparison plugin must be part of the shipped first-party plugin list',
    )
  })

  it('declares the compare_models tool, namespaced storage, and no hook contributions', () => {
    assert.deepEqual(modelComparisonPlugin.manifest.tools?.native, [MODEL_COMPARISON_TOOL_NAME])
    assert.deepEqual(modelComparisonPlugin.manifest.storage, {
      namespace: MODEL_COMPARISON_PLUGIN_ID,
    })
    assert.deepEqual(modelComparisonPlugin.contributions.toolNames, [MODEL_COMPARISON_TOOL_NAME])
    // Same "no static-hook migration" property as the post-turn-review plugin:
    // the auto-on-review trigger and the tool are inline sites, not static
    // hook registrations, so the plugin contributes nothing to the function-hook
    // lists. Pinning this shape makes any accidental double-registration
    // regression a mechanical failure.
    assert.deepEqual(modelComparisonPlugin.contributions.blockingHooks, [])
    assert.deepEqual(modelComparisonPlugin.contributions.asyncHooks, [])
    assert.deepEqual(modelComparisonPlugin.contributions.promptBlocks, [])
    assert.deepEqual(modelComparisonPlugin.contributions.uiContributions, [])
  })

  it('suggests the comparison as a bubble, gated on there being a diff to review', () => {
    // The plugin's user-facing entry point is an offer, not an interruption: a
    // bubble above the composer whose click opens the model picker, rather than
    // a modal that arrives unbidden and rings the alert channels. It is gated on
    // `workspace-changes` because both reviewers read the working diff — with a
    // clean tree the picker would open onto an empty comparison.
    const [bubble, ...rest] = modelComparisonPlugin.contributions.followUps
    assert.deepEqual(rest, [])
    assert.ok(bubble)
    assert.equal(bubble.id, MODEL_COMPARISON_FOLLOW_UP_ID)
    assert.equal(bubble.action, 'model-compare')
    assert.equal(bubble.when, 'workspace-changes')
    // A host action carries no prompt — the click runs the comparison itself
    // instead of putting a sentence in the composer.
    assert.equal(bubble.prompt, undefined)
    assert.deepEqual(modelComparisonPlugin.manifest.followUps, [bubble])
  })

  it('drops the bubble from the active seed on disable, with the tool', () => {
    const registry = createFirstPartyPluginRegistry()
    const bubbleIds = (): string[] => registry.activeFollowUps().map(({ followUp }) => followUp.id)
    assert.ok(bubbleIds().includes(MODEL_COMPARISON_FOLLOW_UP_ID))

    registry.disable(MODEL_COMPARISON_PLUGIN_ID)
    assert.ok(
      !bubbleIds().includes(MODEL_COMPARISON_FOLLOW_UP_ID),
      'the bubble must leave activeFollowUps() in the same flag flip as the tool',
    )
  })

  it('owns reviewer A / reviewer B / judge as plugin-scoped `model` settings', () => {
    // The three comparison models moved off their top-level store keys onto the
    // plugin's own `model` fields. Reviewer B and the judge default to a *rule*
    // rather than a pinned id (the runner expands them into distinct concrete
    // models); reviewer A stays defaultless — blank means the current chat model.
    const settings = modelComparisonPlugin.manifest.settings
    assert.ok(settings)

    const a = settings[COMPARISON_MODEL_A_SETTING_ID]
    assert.ok(a)
    assert.equal(a.kind, 'model')
    assert.equal(a.default, undefined)

    const b = settings[COMPARISON_MODEL_B_SETTING_ID]
    assert.ok(b)
    assert.equal(b.kind, 'model')
    assert.equal(b.default, DEFAULT_COMPARISON_MODEL_ID)

    const judge = settings[COMPARISON_JUDGE_MODEL_SETTING_ID]
    assert.ok(judge)
    assert.equal(judge.kind, 'model')
    assert.equal(judge.default, DEFAULT_COMPARISON_MODEL_ID)

    assert.equal(DEFAULT_COMPARISON_MODEL_ID, BEST_INTELLECT_MODEL_SELECTOR)
    assert.equal(COMPARISON_MODEL_A_SETTING_ID, 'comparisonModelA')
    assert.equal(COMPARISON_MODEL_B_SETTING_ID, 'comparisonModelB')
    assert.equal(COMPARISON_JUDGE_MODEL_SETTING_ID, 'comparisonJudgeModel')
  })

  it('names no pinned model in any setting description', () => {
    // The descriptions used to spell out "Defaults to claude-opus-4-8", which
    // went stale the moment the catalogue moved. A rule describes itself.
    const settings = modelComparisonPlugin.manifest.settings ?? {}
    for (const [id, field] of Object.entries(settings)) {
      assert.doesNotMatch(field.description ?? '', /claude-|gpt-/, `${id} names a model id`)
    }
  })

  it('contributes compare_models exactly once across all first-party plugins', () => {
    // Across the whole shipped seed no other plugin contributes the tool name
    // — otherwise the tool registration in `registry-bootstrap.ts` would be
    // ambiguous once tools are read through the plugin registry.
    const occurrences = FIRST_PARTY_PLUGINS.flatMap(
      (plugin) => plugin.contributions.toolNames,
    ).filter((name) => name === MODEL_COMPARISON_TOOL_NAME)
    assert.equal(occurrences.length, 1)
  })

  it('atomically drops the tool from the active seed on disable', () => {
    const registry = createFirstPartyPluginRegistry()
    assert.equal(registry.isEnabled(MODEL_COMPARISON_PLUGIN_ID), true)
    assert.ok(registry.activeToolNames().includes(MODEL_COMPARISON_TOOL_NAME))

    // Plugin storage survives disable (decision 17).
    registry.storage(MODEL_COMPARISON_PLUGIN_ID).set('lastComparison', 'c-1')

    registry.disable(MODEL_COMPARISON_PLUGIN_ID)
    assert.equal(registry.isEnabled(MODEL_COMPARISON_PLUGIN_ID), false)
    assert.ok(
      !registry.activeToolNames().includes(MODEL_COMPARISON_TOOL_NAME),
      'compare_models must leave activeToolNames() the moment the plugin is disabled',
    )

    registry.enable(MODEL_COMPARISON_PLUGIN_ID)
    assert.ok(registry.activeToolNames().includes(MODEL_COMPARISON_TOOL_NAME))
    assert.equal(registry.storage(MODEL_COMPARISON_PLUGIN_ID).get('lastComparison'), 'c-1')
  })
})
