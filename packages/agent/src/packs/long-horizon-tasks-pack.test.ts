// Contract test: the `copse.long-horizon-tasks` first-party pack.
//
// Landing invariants pinned here (mirrors model-comparison-pack.test.ts):
//
// 1. **The pack is registered** in `FIRST_PARTY_PACKS` with id
//    `copse.long-horizon-tasks` and trust `first-party`, and its manifest +
//    contributions declare the `track_long_task` native tool.
// 2. **No double-registration.** Historically the tool was gated by the
//    top-level `longHorizonTasksEnabled` boolean, which is deleted in the same
//    change (`registry-bootstrap.ts` no longer imports it; the
//    `settings-writable.ts` schema no longer accepts it) — the pack registry is
//    the single source of truth. This test scans the shipped seed and asserts
//    `track_long_task` appears exactly once in `activeToolNames()` (i.e. only
//    the pack contributes it), and that no async/blocking hooks are contributed
//    twice under this pack id.
// 3. **Atomicity of disable.** One flag flip drops the tool from
//    `activeToolNames()`; the host tool-registry sync
//    (`syncLongHorizonTasksTools` in `registry-bootstrap.ts`) reads the same
//    pack registry and unregisters the concrete tool object on toggle. Pack
//    storage survives the disable (decision 17).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  longHorizonTasksPack,
  LONG_HORIZON_TASKS_PACK_ID,
  LONG_HORIZON_TASKS_TOOL_NAME,
} from './long-horizon-tasks-pack.ts'
import { createFirstPartyPackRegistry, FIRST_PARTY_PACKS } from './first-party-packs.ts'

describe('copse.long-horizon-tasks pack', () => {
  it('is registered in FIRST_PARTY_PACKS with id copse.long-horizon-tasks', () => {
    assert.equal(longHorizonTasksPack.id, LONG_HORIZON_TASKS_PACK_ID)
    assert.equal(longHorizonTasksPack.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PACKS.some((pack) => pack.id === LONG_HORIZON_TASKS_PACK_ID),
      'long-horizon-tasks pack must be part of the shipped first-party pack list',
    )
  })

  it('declares the track_long_task tool, namespaced storage, and no hook contributions', () => {
    assert.deepEqual(longHorizonTasksPack.manifest.tools?.native, [LONG_HORIZON_TASKS_TOOL_NAME])
    assert.deepEqual(longHorizonTasksPack.manifest.storage, {
      namespace: LONG_HORIZON_TASKS_PACK_ID,
    })
    assert.deepEqual(longHorizonTasksPack.contributions.toolNames, [LONG_HORIZON_TASKS_TOOL_NAME])
    // The tool is an inline registration site, not a static hook, so the pack
    // contributes nothing to the function-hook lists. Pinning this shape makes
    // any accidental double-registration regression a mechanical failure.
    assert.deepEqual(longHorizonTasksPack.contributions.blockingHooks, [])
    assert.deepEqual(longHorizonTasksPack.contributions.asyncHooks, [])
    assert.deepEqual(longHorizonTasksPack.contributions.promptBlocks, [])
    assert.deepEqual(longHorizonTasksPack.contributions.uiContributions, [])
  })

  it('contributes track_long_task exactly once across all first-party packs', () => {
    // Across the whole shipped seed no other pack contributes the tool name
    // — otherwise the tool registration in `registry-bootstrap.ts` would be
    // ambiguous once tools are read through the pack registry.
    const occurrences = FIRST_PARTY_PACKS.flatMap((pack) => pack.contributions.toolNames).filter(
      (name) => name === LONG_HORIZON_TASKS_TOOL_NAME,
    )
    assert.equal(occurrences.length, 1)
  })

  it('atomically drops the tool from the active seed on disable', () => {
    const registry = createFirstPartyPackRegistry()
    assert.equal(registry.isEnabled(LONG_HORIZON_TASKS_PACK_ID), true)
    assert.ok(registry.activeToolNames().includes(LONG_HORIZON_TASKS_TOOL_NAME))

    // Pack storage survives disable (decision 17).
    registry.storage(LONG_HORIZON_TASKS_PACK_ID).set('lastTask', 't-1')

    registry.disable(LONG_HORIZON_TASKS_PACK_ID)
    assert.equal(registry.isEnabled(LONG_HORIZON_TASKS_PACK_ID), false)
    assert.ok(
      !registry.activeToolNames().includes(LONG_HORIZON_TASKS_TOOL_NAME),
      'track_long_task must leave activeToolNames() the moment the pack is disabled',
    )

    registry.enable(LONG_HORIZON_TASKS_PACK_ID)
    assert.ok(registry.activeToolNames().includes(LONG_HORIZON_TASKS_TOOL_NAME))
    assert.equal(registry.storage(LONG_HORIZON_TASKS_PACK_ID).get('lastTask'), 't-1')
  })
})
