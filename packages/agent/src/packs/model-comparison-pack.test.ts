// Contract test: the `copse.model-comparison` first-party pack (P5).
//
// P5 landing invariants pinned here (docs/plans/hooks-and-feature-packs.md,
// P5 row + "Feature packs" section). Together they prove:
//
// 1. **The pack is registered** in `FIRST_PARTY_PACKS` with id
//    `copse.model-comparison` and trust `first-party`, and its manifest +
//    contributions declare the `compare_models` native tool.
// 2. **No double-registration.** Historically the tool was gated by the
//    top-level `MODEL_COMPARISON_ENABLED_SETTING` boolean, which is deleted in
//    the same change (`registry-bootstrap.ts` no longer imports it; the
//    `settings-writable.ts` schema no longer accepts it) — the pack registry
//    is the single source of truth. This test scans the shipped seed and
//    asserts `compare_models` appears exactly once in
//    `activeToolNames()` (i.e. only the pack contributes it), and that no
//    async/blocking hooks are contributed twice under this pack id.
// 3. **Atomicity of disable.** One flag flip drops the tool from
//    `activeToolNames()`; the host tool-registry sync
//    (`syncModelComparisonTools` in `registry-bootstrap.ts`) reads the same
//    pack registry and unregisters the concrete tool object on toggle. Pack
//    storage survives the disable (decision 17).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  modelComparisonPack,
  MODEL_COMPARISON_PACK_ID,
  MODEL_COMPARISON_TOOL_NAME,
  COMPARISON_MODEL_A_SETTING_ID,
  COMPARISON_MODEL_B_SETTING_ID,
  COMPARISON_JUDGE_MODEL_SETTING_ID,
  DEFAULT_COMPARISON_MODEL_ID,
} from './model-comparison-pack.ts'
import { createFirstPartyPackRegistry, FIRST_PARTY_PACKS } from './first-party-packs.ts'
import { BEST_INTELLECT_MODEL_SELECTOR } from '@copse/llm/dynamic-model.ts'

describe('copse.model-comparison pack (P5)', () => {
  it('is registered in FIRST_PARTY_PACKS with id copse.model-comparison', () => {
    assert.equal(modelComparisonPack.id, MODEL_COMPARISON_PACK_ID)
    assert.equal(modelComparisonPack.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PACKS.some((pack) => pack.id === MODEL_COMPARISON_PACK_ID),
      'model-comparison pack must be part of the shipped first-party pack list',
    )
  })

  it('declares the compare_models tool, namespaced storage, and no hook contributions', () => {
    assert.deepEqual(modelComparisonPack.manifest.tools?.native, [MODEL_COMPARISON_TOOL_NAME])
    assert.deepEqual(modelComparisonPack.manifest.storage, {
      namespace: MODEL_COMPARISON_PACK_ID,
    })
    assert.deepEqual(modelComparisonPack.contributions.toolNames, [MODEL_COMPARISON_TOOL_NAME])
    // Same "no static-hook migration" property as the post-turn-review pack:
    // the auto-on-review trigger and the tool are inline sites, not static
    // hook registrations, so the pack contributes nothing to the function-hook
    // lists. Pinning this shape makes any accidental double-registration
    // regression a mechanical failure.
    assert.deepEqual(modelComparisonPack.contributions.blockingHooks, [])
    assert.deepEqual(modelComparisonPack.contributions.asyncHooks, [])
    assert.deepEqual(modelComparisonPack.contributions.promptBlocks, [])
    assert.deepEqual(modelComparisonPack.contributions.uiContributions, [])
  })

  it('owns reviewer A / reviewer B / judge as pack-scoped `model` settings', () => {
    // The three comparison models moved off their top-level store keys onto the
    // pack's own `model` fields. Reviewer B and the judge default to a *rule*
    // rather than a pinned id (the runner expands them into distinct concrete
    // models); reviewer A stays defaultless — blank means the current chat model.
    const settings = modelComparisonPack.manifest.settings
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
    const settings = modelComparisonPack.manifest.settings ?? {}
    for (const [id, field] of Object.entries(settings)) {
      assert.doesNotMatch(field.description ?? '', /claude-|gpt-/, `${id} names a model id`)
    }
  })

  it('contributes compare_models exactly once across all first-party packs', () => {
    // Across the whole shipped seed no other pack contributes the tool name
    // — otherwise the tool registration in `registry-bootstrap.ts` would be
    // ambiguous once tools are read through the pack registry.
    const occurrences = FIRST_PARTY_PACKS.flatMap((pack) => pack.contributions.toolNames).filter(
      (name) => name === MODEL_COMPARISON_TOOL_NAME,
    )
    assert.equal(occurrences.length, 1)
  })

  it('atomically drops the tool from the active seed on disable', () => {
    const registry = createFirstPartyPackRegistry()
    assert.equal(registry.isEnabled(MODEL_COMPARISON_PACK_ID), true)
    assert.ok(registry.activeToolNames().includes(MODEL_COMPARISON_TOOL_NAME))

    // Pack storage survives disable (decision 17).
    registry.storage(MODEL_COMPARISON_PACK_ID).set('lastComparison', 'c-1')

    registry.disable(MODEL_COMPARISON_PACK_ID)
    assert.equal(registry.isEnabled(MODEL_COMPARISON_PACK_ID), false)
    assert.ok(
      !registry.activeToolNames().includes(MODEL_COMPARISON_TOOL_NAME),
      'compare_models must leave activeToolNames() the moment the pack is disabled',
    )

    registry.enable(MODEL_COMPARISON_PACK_ID)
    assert.ok(registry.activeToolNames().includes(MODEL_COMPARISON_TOOL_NAME))
    assert.equal(registry.storage(MODEL_COMPARISON_PACK_ID).get('lastComparison'), 'c-1')
  })
})
