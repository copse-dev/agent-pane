// Contract test: the `copse.ci-investigator` first-party pack.
//
// Landing invariants pinned here (mirrors model-comparison-pack.test.ts):
//
// 1. **The pack is registered** in `FIRST_PARTY_PACKS` with id
//    `copse.ci-investigator` and trust `first-party`, and its manifest +
//    contributions declare all three native tools (`gh_run_list`,
//    `gh_run_view`, `investigate_ci`).
// 2. **No double-registration.** Historically the tools were gated by the
//    top-level `ciInvestigatorEnabled` boolean, which is deleted in the same
//    change (`registry-bootstrap.ts` no longer imports it; the
//    `settings-writable.ts` schema no longer accepts it) — the pack registry is
//    the single source of truth. This test scans the shipped seed and asserts
//    each tool name appears exactly once in `activeToolNames()` (i.e. only the
//    pack contributes it), and that no async/blocking hooks are contributed
//    under this pack id.
// 3. **Atomicity of disable.** One flag flip drops all three tools from
//    `activeToolNames()`; the host tool-registry sync (`syncCiInvestigatorTools`
//    in `registry-bootstrap.ts`) reads the same pack registry and unregisters
//    the concrete tool objects on toggle (ANDing `gh` availability into the
//    register direction). Pack storage survives the disable (decision 17).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ciInvestigatorPack,
  CI_INVESTIGATOR_PACK_ID,
  CI_INVESTIGATOR_PACK_TOOL_NAMES,
} from './ci-investigator-pack.ts'
import { createFirstPartyPackRegistry, FIRST_PARTY_PACKS } from './first-party-packs.ts'

const TOOL_NAMES = [...CI_INVESTIGATOR_PACK_TOOL_NAMES]

describe('copse.ci-investigator pack', () => {
  it('is registered in FIRST_PARTY_PACKS with id copse.ci-investigator', () => {
    assert.equal(ciInvestigatorPack.id, CI_INVESTIGATOR_PACK_ID)
    assert.equal(ciInvestigatorPack.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PACKS.some((pack) => pack.id === CI_INVESTIGATOR_PACK_ID),
      'ci-investigator pack must be part of the shipped first-party pack list',
    )
  })

  it('declares the three CI tools, namespaced storage, and no hook contributions', () => {
    assert.deepEqual(ciInvestigatorPack.manifest.tools?.native, TOOL_NAMES)
    assert.deepEqual(ciInvestigatorPack.manifest.storage, {
      namespace: CI_INVESTIGATOR_PACK_ID,
    })
    assert.deepEqual(ciInvestigatorPack.contributions.toolNames, TOOL_NAMES)
    // The tools are inline registration sites, not static hooks, so the pack
    // contributes nothing to the function-hook lists. Pinning this shape makes
    // any accidental double-registration regression a mechanical failure.
    assert.deepEqual(ciInvestigatorPack.contributions.blockingHooks, [])
    assert.deepEqual(ciInvestigatorPack.contributions.asyncHooks, [])
    assert.deepEqual(ciInvestigatorPack.contributions.promptBlocks, [])
    assert.deepEqual(ciInvestigatorPack.contributions.uiContributions, [])
  })

  it('contributes each CI tool exactly once across all first-party packs', () => {
    // Across the whole shipped seed no other pack contributes these tool names
    // — otherwise the tool registration in `registry-bootstrap.ts` would be
    // ambiguous once tools are read through the pack registry.
    const allToolNames = FIRST_PARTY_PACKS.flatMap((pack) => pack.contributions.toolNames)
    for (const name of TOOL_NAMES) {
      assert.equal(
        allToolNames.filter((n) => n === name).length,
        1,
        `${name} must be contributed by exactly one pack`,
      )
    }
  })

  it('atomically drops every tool from the active seed on disable', () => {
    const registry = createFirstPartyPackRegistry()
    // Experimental: the manifest declares `defaultEnabled: false`, so a fresh
    // seed ships it off. Opt in explicitly to exercise the disable path below.
    assert.equal(registry.isEnabled(CI_INVESTIGATOR_PACK_ID), false)
    registry.enable(CI_INVESTIGATOR_PACK_ID)
    for (const name of TOOL_NAMES) {
      assert.ok(registry.activeToolNames().includes(name), `${name} active while enabled`)
    }

    // Pack storage survives disable (decision 17).
    registry.storage(CI_INVESTIGATOR_PACK_ID).set('lastRun', 'r-1')

    registry.disable(CI_INVESTIGATOR_PACK_ID)
    assert.equal(registry.isEnabled(CI_INVESTIGATOR_PACK_ID), false)
    for (const name of TOOL_NAMES) {
      assert.ok(
        !registry.activeToolNames().includes(name),
        `${name} must leave activeToolNames() the moment the pack is disabled`,
      )
    }

    registry.enable(CI_INVESTIGATOR_PACK_ID)
    for (const name of TOOL_NAMES) {
      assert.ok(registry.activeToolNames().includes(name), `${name} restored on re-enable`)
    }
    assert.equal(registry.storage(CI_INVESTIGATOR_PACK_ID).get('lastRun'), 'r-1')
  })
})
