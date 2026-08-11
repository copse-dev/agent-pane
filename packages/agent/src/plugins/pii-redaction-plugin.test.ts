// Contract test: the `copse.pii-redaction` first-party plugin.
//
// Landing invariants pinned here (mirrors model-comparison-plugin.test.ts):
//
// 1. **The plugin is registered** in `FIRST_PARTY_PLUGINS` with id
//    `copse.pii-redaction` and trust `first-party`, and its manifest +
//    contributions declare the `reveal_pii` native tool and the redaction
//    steering prompt block.
// 2. **No double-registration.** Historically the tool was gated (and the
//    prompt block appended, and the input rewritten) by the top-level
//    `piiRedactionEnabled` boolean, which is deleted in the same change
//    (`registry-bootstrap.ts` no longer imports it; the `settings-writable.ts`
//    schema no longer accepts it) — the plugin registry is the single source of
//    truth. This test scans the shipped seed and asserts `reveal_pii` appears
//    exactly once in `activeToolNames()` (i.e. only the plugin contributes it).
// 3. **Atomicity of disable.** One flag flip drops the tool from
//    `activeToolNames()`; the host tool-registry sync (`syncPiiTools` in
//    `registry-bootstrap.ts`) reads the same plugin registry and unregisters the
//    concrete tool object on toggle. Plugin storage survives the disable
//    (decision 17).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  piiRedactionPlugin,
  PII_REDACTION_PLUGIN_ID,
  PII_REDACTION_TOOL_NAME,
  PII_REDACTION_BLOCK,
} from './pii-redaction-plugin.ts'
import { createFirstPartyPluginRegistry, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'

describe('copse.pii-redaction plugin', () => {
  it('is registered in FIRST_PARTY_PLUGINS with id copse.pii-redaction', () => {
    assert.equal(piiRedactionPlugin.id, PII_REDACTION_PLUGIN_ID)
    assert.equal(piiRedactionPlugin.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PLUGINS.some((plugin) => plugin.id === PII_REDACTION_PLUGIN_ID),
      'pii-redaction plugin must be part of the shipped first-party plugin list',
    )
  })

  it('declares the reveal_pii tool, the redaction prompt block, namespaced storage, and no hooks/ui', () => {
    assert.deepEqual(piiRedactionPlugin.manifest.tools?.native, [PII_REDACTION_TOOL_NAME])
    assert.deepEqual(piiRedactionPlugin.manifest.storage, { namespace: PII_REDACTION_PLUGIN_ID })
    assert.deepEqual(piiRedactionPlugin.contributions.toolNames, [PII_REDACTION_TOOL_NAME])

    // The redaction steering block is declared both in the manifest (`prompt`)
    // and in the runtime contributions (`promptBlocks`) as the same trusted
    // first-party block, carrying the exact text the host appends (assert on the
    // whole array so element access never trips noUncheckedIndexedAccess).
    const expectedBlock = { id: 'pii-redaction-block', text: PII_REDACTION_BLOCK, trust: 'trusted' }
    assert.deepEqual(piiRedactionPlugin.contributions.promptBlocks, [expectedBlock])
    assert.deepEqual(piiRedactionPlugin.manifest.prompt, [expectedBlock])
    assert.match(PII_REDACTION_BLOCK, /reveal_pii/)

    // The tool is an inline registration site, not a static hook, and the plugin
    // ships no renderer view — pinning these shapes makes any accidental
    // double-registration or stray contribution a mechanical failure.
    assert.deepEqual(piiRedactionPlugin.contributions.blockingHooks, [])
    assert.deepEqual(piiRedactionPlugin.contributions.asyncHooks, [])
    assert.deepEqual(piiRedactionPlugin.contributions.uiContributions, [])
  })

  it('contributes reveal_pii exactly once across all first-party plugins', () => {
    // Across the whole shipped seed no other plugin contributes the tool name
    // — otherwise the tool registration in `registry-bootstrap.ts` would be
    // ambiguous once tools are read through the plugin registry.
    const occurrences = FIRST_PARTY_PLUGINS.flatMap(
      (plugin) => plugin.contributions.toolNames,
    ).filter((name) => name === PII_REDACTION_TOOL_NAME)
    assert.equal(occurrences.length, 1)
  })

  it('atomically drops the tool from the active seed on disable', () => {
    const registry = createFirstPartyPluginRegistry()
    assert.equal(registry.isEnabled(PII_REDACTION_PLUGIN_ID), true)
    assert.ok(registry.activeToolNames().includes(PII_REDACTION_TOOL_NAME))

    // Plugin storage survives disable (decision 17).
    registry.storage(PII_REDACTION_PLUGIN_ID).set('lastThread', 't-1')

    registry.disable(PII_REDACTION_PLUGIN_ID)
    assert.equal(registry.isEnabled(PII_REDACTION_PLUGIN_ID), false)
    assert.ok(
      !registry.activeToolNames().includes(PII_REDACTION_TOOL_NAME),
      'reveal_pii must leave activeToolNames() the moment the plugin is disabled',
    )

    registry.enable(PII_REDACTION_PLUGIN_ID)
    assert.ok(registry.activeToolNames().includes(PII_REDACTION_TOOL_NAME))
    assert.equal(registry.storage(PII_REDACTION_PLUGIN_ID).get('lastThread'), 't-1')
  })
})
