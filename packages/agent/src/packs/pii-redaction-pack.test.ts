// Contract test: the `copse.pii-redaction` first-party pack.
//
// Landing invariants pinned here (mirrors model-comparison-pack.test.ts):
//
// 1. **The pack is registered** in `FIRST_PARTY_PACKS` with id
//    `copse.pii-redaction` and trust `first-party`, and its manifest +
//    contributions declare the `reveal_pii` native tool and the redaction
//    steering prompt block.
// 2. **No double-registration.** Historically the tool was gated (and the
//    prompt block appended, and the input rewritten) by the top-level
//    `piiRedactionEnabled` boolean, which is deleted in the same change
//    (`registry-bootstrap.ts` no longer imports it; the `settings-writable.ts`
//    schema no longer accepts it) — the pack registry is the single source of
//    truth. This test scans the shipped seed and asserts `reveal_pii` appears
//    exactly once in `activeToolNames()` (i.e. only the pack contributes it).
// 3. **Atomicity of disable.** One flag flip drops the tool from
//    `activeToolNames()`; the host tool-registry sync (`syncPiiTools` in
//    `registry-bootstrap.ts`) reads the same pack registry and unregisters the
//    concrete tool object on toggle. Pack storage survives the disable
//    (decision 17).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  piiRedactionPack,
  PII_REDACTION_PACK_ID,
  PII_REDACTION_TOOL_NAME,
  PII_REDACTION_BLOCK,
} from './pii-redaction-pack.ts'
import { createFirstPartyPackRegistry, FIRST_PARTY_PACKS } from './first-party-packs.ts'

describe('copse.pii-redaction pack', () => {
  it('is registered in FIRST_PARTY_PACKS with id copse.pii-redaction', () => {
    assert.equal(piiRedactionPack.id, PII_REDACTION_PACK_ID)
    assert.equal(piiRedactionPack.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PACKS.some((pack) => pack.id === PII_REDACTION_PACK_ID),
      'pii-redaction pack must be part of the shipped first-party pack list',
    )
  })

  it('declares the reveal_pii tool, the redaction prompt block, namespaced storage, and no hooks/ui', () => {
    assert.deepEqual(piiRedactionPack.manifest.tools?.native, [PII_REDACTION_TOOL_NAME])
    assert.deepEqual(piiRedactionPack.manifest.storage, { namespace: PII_REDACTION_PACK_ID })
    assert.deepEqual(piiRedactionPack.contributions.toolNames, [PII_REDACTION_TOOL_NAME])

    // The redaction steering block is declared both in the manifest (`prompt`)
    // and in the runtime contributions (`promptBlocks`) as the same trusted
    // first-party block, carrying the exact text the host appends (assert on the
    // whole array so element access never trips noUncheckedIndexedAccess).
    const expectedBlock = { id: 'pii-redaction-block', text: PII_REDACTION_BLOCK, trust: 'trusted' }
    assert.deepEqual(piiRedactionPack.contributions.promptBlocks, [expectedBlock])
    assert.deepEqual(piiRedactionPack.manifest.prompt, [expectedBlock])
    assert.match(PII_REDACTION_BLOCK, /reveal_pii/)

    // The tool is an inline registration site, not a static hook, and the pack
    // ships no renderer view — pinning these shapes makes any accidental
    // double-registration or stray contribution a mechanical failure.
    assert.deepEqual(piiRedactionPack.contributions.blockingHooks, [])
    assert.deepEqual(piiRedactionPack.contributions.asyncHooks, [])
    assert.deepEqual(piiRedactionPack.contributions.uiContributions, [])
  })

  it('contributes reveal_pii exactly once across all first-party packs', () => {
    // Across the whole shipped seed no other pack contributes the tool name
    // — otherwise the tool registration in `registry-bootstrap.ts` would be
    // ambiguous once tools are read through the pack registry.
    const occurrences = FIRST_PARTY_PACKS.flatMap((pack) => pack.contributions.toolNames).filter(
      (name) => name === PII_REDACTION_TOOL_NAME,
    )
    assert.equal(occurrences.length, 1)
  })

  it('atomically drops the tool from the active seed on disable', () => {
    const registry = createFirstPartyPackRegistry()
    assert.equal(registry.isEnabled(PII_REDACTION_PACK_ID), true)
    assert.ok(registry.activeToolNames().includes(PII_REDACTION_TOOL_NAME))

    // Pack storage survives disable (decision 17).
    registry.storage(PII_REDACTION_PACK_ID).set('lastThread', 't-1')

    registry.disable(PII_REDACTION_PACK_ID)
    assert.equal(registry.isEnabled(PII_REDACTION_PACK_ID), false)
    assert.ok(
      !registry.activeToolNames().includes(PII_REDACTION_TOOL_NAME),
      'reveal_pii must leave activeToolNames() the moment the pack is disabled',
    )

    registry.enable(PII_REDACTION_PACK_ID)
    assert.ok(registry.activeToolNames().includes(PII_REDACTION_TOOL_NAME))
    assert.equal(registry.storage(PII_REDACTION_PACK_ID).get('lastThread'), 't-1')
  })
})
