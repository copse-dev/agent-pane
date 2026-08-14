import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AUTOMATIONS_PLUGIN_ID, automationsPlugin } from './automations-plugin.ts'
import { PluginRegistry } from './plugin-registry.ts'

describe('copse.automations plugin', () => {
  it('declares a first-party level-3 settings detail and persistent namespace', () => {
    assert.equal(automationsPlugin.id, AUTOMATIONS_PLUGIN_ID)
    assert.equal(automationsPlugin.trust, 'first-party')
    assert.deepEqual(automationsPlugin.manifest.storage, { namespace: AUTOMATIONS_PLUGIN_ID })
    assert.deepEqual(automationsPlugin.contributions.uiContributions, [
      {
        id: 'schedule-editor',
        level: 3,
        slot: 'settings-plugin-detail',
        title: 'Automation schedules',
      },
    ])
  })

  it('drops the live UI contribution atomically while retaining the manifest storage declaration', () => {
    const registry = new PluginRegistry()
    registry.register(automationsPlugin)
    assert.equal(registry.activeUiContributions().length, 1)
    registry.disable(AUTOMATIONS_PLUGIN_ID)
    assert.equal(registry.activeUiContributions().length, 0)
    const registered = registry.get(AUTOMATIONS_PLUGIN_ID)
    assert.ok(registered)
    assert.deepEqual(registered.manifest.storage, {
      namespace: AUTOMATIONS_PLUGIN_ID,
    })
  })
})
