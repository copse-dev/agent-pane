// Contract test: the `copse.devtools-shortcut` first-party pack.
//
// Landing invariants pinned here (mirrors mcp-ui-canvas-pack.test.ts):
//
// 1. **The pack is registered** in `FIRST_PARTY_PACKS` with id
//    `copse.devtools-shortcut` and trust `first-party`, and its manifest +
//    contributions declare the `devtools-shortcut` capability and NO tool/hook/
//    prompt/ui (it is a pure behaviour flag).
// 2. **Single owner.** Across the shipped seed the `devtools-shortcut`
//    capability is declared exactly once, so the host read site
//    (`create-main-window.ts` `syncDevtoolsShortcut`) resolves it unambiguously
//    through `isCapabilityActive`.
// 3. **Atomicity of disable.** One flag flip drops the capability from
//    `isCapabilityActive('devtools-shortcut')`. The default-OFF product
//    behaviour is enforced by the pack-service enablement migration, not the raw
//    registry seed, so this test toggles enablement explicitly.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  devtoolsShortcutPack,
  DEVTOOLS_SHORTCUT_PACK_ID,
  DEVTOOLS_SHORTCUT_CAPABILITY,
} from './devtools-shortcut-pack.ts'
import { createFirstPartyPackRegistry, FIRST_PARTY_PACKS } from './first-party-packs.ts'

describe('copse.devtools-shortcut pack', () => {
  it('is registered in FIRST_PARTY_PACKS with id copse.devtools-shortcut', () => {
    assert.equal(devtoolsShortcutPack.id, DEVTOOLS_SHORTCUT_PACK_ID)
    assert.equal(devtoolsShortcutPack.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PACKS.some((pack) => pack.id === DEVTOOLS_SHORTCUT_PACK_ID),
      'devtools-shortcut pack must be part of the shipped first-party pack list',
    )
  })

  it('declares the devtools-shortcut capability and no tool/hook/prompt/ui contributions', () => {
    assert.equal(
      devtoolsShortcutPack.manifest.capabilities?.[0]?.name,
      DEVTOOLS_SHORTCUT_CAPABILITY,
    )
    assert.equal(
      devtoolsShortcutPack.contributions.capabilities[0]?.name,
      DEVTOOLS_SHORTCUT_CAPABILITY,
    )
    assert.deepEqual(devtoolsShortcutPack.contributions.toolNames, [])
    assert.deepEqual(devtoolsShortcutPack.contributions.blockingHooks, [])
    assert.deepEqual(devtoolsShortcutPack.contributions.asyncHooks, [])
    assert.deepEqual(devtoolsShortcutPack.contributions.promptBlocks, [])
    assert.deepEqual(devtoolsShortcutPack.contributions.uiContributions, [])
    assert.equal(devtoolsShortcutPack.manifest.tools, undefined)
  })

  it('declares devtools-shortcut exactly once across all first-party packs', () => {
    const occurrences = FIRST_PARTY_PACKS.flatMap((pack) =>
      pack.contributions.capabilities.map((c) => c.name),
    ).filter((name) => name === DEVTOOLS_SHORTCUT_CAPABILITY)
    assert.equal(occurrences.length, 1)
  })

  it('atomically drops the capability on disable', () => {
    const registry = createFirstPartyPackRegistry()
    // Experimental: the manifest declares `defaultEnabled: false`, so a fresh
    // seed ships it off. Opt in explicitly to exercise the disable path below.
    assert.equal(registry.isEnabled(DEVTOOLS_SHORTCUT_PACK_ID), false)
    registry.enable(DEVTOOLS_SHORTCUT_PACK_ID)
    assert.equal(registry.isCapabilityActive(DEVTOOLS_SHORTCUT_CAPABILITY), true)

    registry.disable(DEVTOOLS_SHORTCUT_PACK_ID)
    assert.equal(registry.isEnabled(DEVTOOLS_SHORTCUT_PACK_ID), false)
    assert.equal(
      registry.isCapabilityActive(DEVTOOLS_SHORTCUT_CAPABILITY),
      false,
      'devtools-shortcut must leave isCapabilityActive() the moment the pack is disabled',
    )

    registry.enable(DEVTOOLS_SHORTCUT_PACK_ID)
    assert.equal(registry.isCapabilityActive(DEVTOOLS_SHORTCUT_CAPABILITY), true)
  })
})
