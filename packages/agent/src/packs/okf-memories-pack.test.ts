// Contract test: the `copse.okf-memories` first-party pack.
//
// Landing invariants pinned here (mirrors model-comparison-pack.test.ts):
//
// 1. **The pack is registered** in `FIRST_PARTY_PACKS` with id
//    `copse.okf-memories` and trust `first-party`, and its manifest +
//    contributions declare the `remember`/`recall` native tools and the memory
//    steering prompt block.
// 2. **No double-registration.** Historically the tools were gated by the
//    top-level `okfMemoriesEnabled` boolean, which is deleted in the same change
//    (`registry-bootstrap.ts` no longer imports it; the `settings-writable.ts`
//    schema no longer accepts it) — the pack registry is the single source of
//    truth. This test scans the shipped seed and asserts each tool name appears
//    exactly once in `activeToolNames()` (i.e. only the pack contributes it),
//    and that no async/blocking hooks are contributed under this pack id.
// 3. **Atomicity of disable.** One flag flip drops both tools from
//    `activeToolNames()`; the host tool-registry sync (`syncOkfMemoryTools` in
//    `registry-bootstrap.ts`) reads the same pack registry and unregisters the
//    concrete tool objects on toggle. Pack storage survives the disable
//    (decision 17).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  okfMemoriesPack,
  OKF_MEMORIES_PACK_ID,
  OKF_MEMORIES_TOOL_NAMES,
  OKF_MEMORIES_PROMPT_BLOCK_ID,
  MEMORY_TOOLS_BLOCK,
} from './okf-memories-pack.ts'
import { createFirstPartyPackRegistry, FIRST_PARTY_PACKS } from './first-party-packs.ts'

describe('copse.okf-memories pack', () => {
  it('is registered in FIRST_PARTY_PACKS with id copse.okf-memories', () => {
    assert.equal(okfMemoriesPack.id, OKF_MEMORIES_PACK_ID)
    assert.equal(okfMemoriesPack.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PACKS.some((pack) => pack.id === OKF_MEMORIES_PACK_ID),
      'okf-memories pack must be part of the shipped first-party pack list',
    )
  })

  it('declares the remember/recall tools, the memory prompt block, namespaced storage, and no hooks', () => {
    assert.deepEqual(okfMemoriesPack.manifest.tools?.native, [...OKF_MEMORIES_TOOL_NAMES])
    assert.deepEqual(okfMemoriesPack.manifest.storage, {
      namespace: OKF_MEMORIES_PACK_ID,
    })
    assert.deepEqual(okfMemoriesPack.contributions.toolNames, [...OKF_MEMORIES_TOOL_NAMES])
    // The memory steering block is a trusted first-party prompt contribution;
    // the host appends the identical text (imported from the pack) while the
    // pack is enabled. Pinning the shape keeps the pack decl and the host
    // appending site from drifting.
    assert.deepEqual(okfMemoriesPack.manifest.prompt, [
      { id: OKF_MEMORIES_PROMPT_BLOCK_ID, text: MEMORY_TOOLS_BLOCK, trust: 'trusted' },
    ])
    assert.deepEqual(okfMemoriesPack.contributions.promptBlocks, [
      { id: OKF_MEMORIES_PROMPT_BLOCK_ID, text: MEMORY_TOOLS_BLOCK, trust: 'trusted' },
    ])
    // The tools are inline registration sites, not static hooks, so the pack
    // contributes nothing to the function-hook lists. Pinning this shape makes
    // any accidental double-registration regression a mechanical failure.
    assert.deepEqual(okfMemoriesPack.contributions.blockingHooks, [])
    assert.deepEqual(okfMemoriesPack.contributions.asyncHooks, [])
    assert.deepEqual(okfMemoriesPack.contributions.uiContributions, [])
  })

  it('contributes remember and recall exactly once each across all first-party packs', () => {
    // Across the whole shipped seed no other pack contributes either tool name
    // — otherwise the tool registration in `registry-bootstrap.ts` would be
    // ambiguous once tools are read through the pack registry.
    const allToolNames = FIRST_PARTY_PACKS.flatMap((pack) => pack.contributions.toolNames)
    for (const name of OKF_MEMORIES_TOOL_NAMES) {
      assert.equal(
        allToolNames.filter((n) => n === name).length,
        1,
        `${name} must be contributed by exactly one pack`,
      )
    }
  })

  it('atomically drops both tools from the active seed on disable', () => {
    const registry = createFirstPartyPackRegistry()
    assert.equal(registry.isEnabled(OKF_MEMORIES_PACK_ID), true)
    for (const name of OKF_MEMORIES_TOOL_NAMES) {
      assert.ok(registry.activeToolNames().includes(name))
    }

    // Pack storage survives disable (decision 17).
    registry.storage(OKF_MEMORIES_PACK_ID).set('lastMemory', 'm-1')

    registry.disable(OKF_MEMORIES_PACK_ID)
    assert.equal(registry.isEnabled(OKF_MEMORIES_PACK_ID), false)
    for (const name of OKF_MEMORIES_TOOL_NAMES) {
      assert.ok(
        !registry.activeToolNames().includes(name),
        `${name} must leave activeToolNames() the moment the pack is disabled`,
      )
    }

    registry.enable(OKF_MEMORIES_PACK_ID)
    for (const name of OKF_MEMORIES_TOOL_NAMES) {
      assert.ok(registry.activeToolNames().includes(name))
    }
    assert.equal(registry.storage(OKF_MEMORIES_PACK_ID).get('lastMemory'), 'm-1')
  })
})
