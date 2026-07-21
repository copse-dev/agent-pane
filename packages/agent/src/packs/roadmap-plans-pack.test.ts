// Contract test: the `copse.roadmap-plans` first-party pack.
//
// Landing invariants pinned here (mirrors model-comparison-pack.test.ts):
//
// 1. **The pack is registered** in `FIRST_PARTY_PACKS` with id
//    `copse.roadmap-plans` and trust `first-party`, and its manifest +
//    contributions declare the `roadmap_plan` native tool.
// 2. **No double-registration.** Historically the tool was gated by the
//    top-level `roadmapPlansEnabled` boolean, which is deleted in the same
//    change (`registry-bootstrap.ts` no longer imports it; the
//    `settings-writable.ts` schema no longer accepts it) — the pack registry is
//    the single source of truth. This test scans the shipped seed and asserts
//    `roadmap_plan` appears exactly once in `activeToolNames()` (i.e. only the
//    pack contributes it), and that no async/blocking hooks are contributed
//    twice under this pack id.
// 3. **Atomicity of disable.** One flag flip drops the tool from
//    `activeToolNames()`; the host tool-registry sync (`syncRoadmapPlanTools`
//    in `registry-bootstrap.ts`) reads the same pack registry and unregisters
//    the concrete tool object on toggle. Pack storage survives the disable
//    (decision 17).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  roadmapPlansPack,
  ROADMAP_PLANS_PACK_ID,
  ROADMAP_PLANS_TOOL_NAME,
} from './roadmap-plans-pack.ts'
import { createFirstPartyPackRegistry, FIRST_PARTY_PACKS } from './first-party-packs.ts'

describe('copse.roadmap-plans pack', () => {
  it('is registered in FIRST_PARTY_PACKS with id copse.roadmap-plans', () => {
    assert.equal(roadmapPlansPack.id, ROADMAP_PLANS_PACK_ID)
    assert.equal(roadmapPlansPack.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PACKS.some((pack) => pack.id === ROADMAP_PLANS_PACK_ID),
      'roadmap-plans pack must be part of the shipped first-party pack list',
    )
  })

  it('declares the roadmap_plan tool, namespaced storage, and no hook contributions', () => {
    assert.deepEqual(roadmapPlansPack.manifest.tools?.native, [ROADMAP_PLANS_TOOL_NAME])
    assert.deepEqual(roadmapPlansPack.manifest.storage, {
      namespace: ROADMAP_PLANS_PACK_ID,
    })
    assert.deepEqual(roadmapPlansPack.contributions.toolNames, [ROADMAP_PLANS_TOOL_NAME])
    // The tool is an inline registration site, not a static hook, so the pack
    // contributes nothing to the function-hook lists. Pinning this shape makes
    // any accidental double-registration regression a mechanical failure.
    assert.deepEqual(roadmapPlansPack.contributions.blockingHooks, [])
    assert.deepEqual(roadmapPlansPack.contributions.asyncHooks, [])
    assert.deepEqual(roadmapPlansPack.contributions.promptBlocks, [])
    assert.deepEqual(roadmapPlansPack.contributions.uiContributions, [])
  })

  it('contributes roadmap_plan exactly once across all first-party packs', () => {
    // Across the whole shipped seed no other pack contributes the tool name
    // — otherwise the tool registration in `registry-bootstrap.ts` would be
    // ambiguous once tools are read through the pack registry.
    const occurrences = FIRST_PARTY_PACKS.flatMap((pack) => pack.contributions.toolNames).filter(
      (name) => name === ROADMAP_PLANS_TOOL_NAME,
    )
    assert.equal(occurrences.length, 1)
  })

  it('atomically drops the tool from the active seed on disable', () => {
    const registry = createFirstPartyPackRegistry()
    assert.equal(registry.isEnabled(ROADMAP_PLANS_PACK_ID), true)
    assert.ok(registry.activeToolNames().includes(ROADMAP_PLANS_TOOL_NAME))

    // Pack storage survives disable (decision 17).
    registry.storage(ROADMAP_PLANS_PACK_ID).set('lastItem', 'r-1')

    registry.disable(ROADMAP_PLANS_PACK_ID)
    assert.equal(registry.isEnabled(ROADMAP_PLANS_PACK_ID), false)
    assert.ok(
      !registry.activeToolNames().includes(ROADMAP_PLANS_TOOL_NAME),
      'roadmap_plan must leave activeToolNames() the moment the pack is disabled',
    )

    registry.enable(ROADMAP_PLANS_PACK_ID)
    assert.ok(registry.activeToolNames().includes(ROADMAP_PLANS_TOOL_NAME))
    assert.equal(registry.storage(ROADMAP_PLANS_PACK_ID).get('lastItem'), 'r-1')
  })
})
