// Contract test: the `copse.advisor-strategy` first-party pack.
//
// Landing invariants pinned here (mirrors model-comparison-pack.test.ts):
//
// 1. **The pack is registered** in `FIRST_PARTY_PACKS` with id
//    `copse.advisor-strategy` and trust `first-party`, and its manifest +
//    contributions declare the `advisor` native tool.
// 2. **No double-registration.** Historically the tool was gated by the
//    top-level `advisorStrategyEnabled` boolean, which is deleted in the same
//    change (`registry-bootstrap.ts` no longer imports it; the
//    `settings-writable.ts` schema no longer accepts it) — the pack registry is
//    the single source of truth. This test scans the shipped seed and asserts
//    `advisor` appears exactly once in `activeToolNames()` (i.e. only the pack
//    contributes it), and that no async/blocking hooks are contributed twice
//    under this pack id.
// 3. **Atomicity of disable.** One flag flip drops the tool from
//    `activeToolNames()`; the host tool-registry sync (`syncAdvisorStrategyTools`
//    in `registry-bootstrap.ts`) reads the same pack registry and unregisters
//    the concrete tool object on toggle. Pack storage survives the disable
//    (decision 17).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  advisorStrategyPack,
  ADVISOR_STRATEGY_PACK_ID,
  ADVISOR_STRATEGY_TOOL_NAME,
  ADVISOR_MODEL_SETTING_ID,
  DEFAULT_ADVISOR_MODEL_ID,
} from './advisor-strategy-pack.ts'
import { createFirstPartyPackRegistry, FIRST_PARTY_PACKS } from './first-party-packs.ts'

describe('copse.advisor-strategy pack', () => {
  it('is registered in FIRST_PARTY_PACKS with id copse.advisor-strategy', () => {
    assert.equal(advisorStrategyPack.id, ADVISOR_STRATEGY_PACK_ID)
    assert.equal(advisorStrategyPack.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PACKS.some((pack) => pack.id === ADVISOR_STRATEGY_PACK_ID),
      'advisor-strategy pack must be part of the shipped first-party pack list',
    )
  })

  it('declares the advisor tool, namespaced storage, and no hook contributions', () => {
    assert.deepEqual(advisorStrategyPack.manifest.tools?.native, [ADVISOR_STRATEGY_TOOL_NAME])
    assert.deepEqual(advisorStrategyPack.manifest.storage, {
      namespace: ADVISOR_STRATEGY_PACK_ID,
    })
    assert.deepEqual(advisorStrategyPack.contributions.toolNames, [ADVISOR_STRATEGY_TOOL_NAME])
    // The tool is an inline registration site, not a static hook, so the pack
    // contributes nothing to the function-hook lists. Pinning this shape makes
    // any accidental double-registration regression a mechanical failure.
    assert.deepEqual(advisorStrategyPack.contributions.blockingHooks, [])
    assert.deepEqual(advisorStrategyPack.contributions.asyncHooks, [])
    assert.deepEqual(advisorStrategyPack.contributions.promptBlocks, [])
    assert.deepEqual(advisorStrategyPack.contributions.uiContributions, [])
  })

  it('owns the advisor model as a pack-scoped `model` setting with the frontier default', () => {
    // The advisor model moved off the top-level `advisorModel` store key onto
    // this pack's own `model` field, so the pack fully owns its model config.
    const field = advisorStrategyPack.manifest.settings?.[ADVISOR_MODEL_SETTING_ID]
    assert.ok(field, 'advisor-strategy pack must declare the advisorModel setting')
    assert.equal(field.kind, 'model')
    assert.equal(field.default, DEFAULT_ADVISOR_MODEL_ID)
    assert.equal(DEFAULT_ADVISOR_MODEL_ID, 'claude-opus-4-8')
    // A model field never bakes a static option list — the catalogue is live.
    assert.equal(field.options, undefined)
    assert.equal(ADVISOR_MODEL_SETTING_ID, 'advisorModel')
  })

  it('contributes advisor exactly once across all first-party packs', () => {
    // Across the whole shipped seed no other pack contributes the tool name
    // — otherwise the tool registration in `registry-bootstrap.ts` would be
    // ambiguous once tools are read through the pack registry.
    const occurrences = FIRST_PARTY_PACKS.flatMap((pack) => pack.contributions.toolNames).filter(
      (name) => name === ADVISOR_STRATEGY_TOOL_NAME,
    )
    assert.equal(occurrences.length, 1)
  })

  it('atomically drops the tool from the active seed on disable', () => {
    const registry = createFirstPartyPackRegistry()
    assert.equal(registry.isEnabled(ADVISOR_STRATEGY_PACK_ID), true)
    assert.ok(registry.activeToolNames().includes(ADVISOR_STRATEGY_TOOL_NAME))

    // Pack storage survives disable (decision 17).
    registry.storage(ADVISOR_STRATEGY_PACK_ID).set('lastAdvisor', 'claude-opus-4-8')

    registry.disable(ADVISOR_STRATEGY_PACK_ID)
    assert.equal(registry.isEnabled(ADVISOR_STRATEGY_PACK_ID), false)
    assert.ok(
      !registry.activeToolNames().includes(ADVISOR_STRATEGY_TOOL_NAME),
      'advisor must leave activeToolNames() the moment the pack is disabled',
    )

    registry.enable(ADVISOR_STRATEGY_PACK_ID)
    assert.ok(registry.activeToolNames().includes(ADVISOR_STRATEGY_TOOL_NAME))
    assert.equal(registry.storage(ADVISOR_STRATEGY_PACK_ID).get('lastAdvisor'), 'claude-opus-4-8')
  })
})
