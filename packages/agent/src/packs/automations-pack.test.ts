import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AUTOMATIONS_PACK_ID, automationsPack } from './automations-pack.ts'
import { PackRegistry } from './pack-registry.ts'

describe('copse.automations pack', () => {
  it('declares a first-party level-3 settings detail and persistent namespace', () => {
    assert.equal(automationsPack.id, AUTOMATIONS_PACK_ID)
    assert.equal(automationsPack.trust, 'first-party')
    assert.deepEqual(automationsPack.manifest.storage, { namespace: AUTOMATIONS_PACK_ID })
    assert.deepEqual(automationsPack.contributions.uiContributions, [
      {
        id: 'schedule-editor',
        level: 3,
        slot: 'settings-pack-detail',
        title: 'Automation schedules',
      },
    ])
  })

  it('drops the live UI contribution atomically while retaining the manifest storage declaration', () => {
    const registry = new PackRegistry()
    registry.register(automationsPack)
    assert.equal(registry.activeUiContributions().length, 1)
    registry.disable(AUTOMATIONS_PACK_ID)
    assert.equal(registry.activeUiContributions().length, 0)
    const registered = registry.get(AUTOMATIONS_PACK_ID)
    assert.ok(registered)
    assert.deepEqual(registered.manifest.storage, {
      namespace: AUTOMATIONS_PACK_ID,
    })
  })
})
