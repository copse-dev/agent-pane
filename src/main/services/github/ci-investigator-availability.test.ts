import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  ciInvestigatorToolsRegistrable,
  isInvestigateCiOffered,
} from './ci-investigator-availability.ts'
import { setSetting } from '../storage/settings.test-shim.ts'
import { setGhAvailableForTest } from '../tool-availability.ts'
import { SUBAGENTS_ENABLED_SETTING } from '../subagents-setting.ts'
import { setDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { createFirstPartyPluginRegistry } from '@copse/agent/plugins/first-party-plugins.ts'
import { CI_INVESTIGATOR_PLUGIN_ID } from '@copse/agent/plugins/ci-investigator-plugin.ts'

function arrange(plugin: boolean, gh: boolean, subagents: boolean, readonly = false): void {
  const plugins = createFirstPartyPluginRegistry()
  if (plugin) plugins.enable(CI_INVESTIGATOR_PLUGIN_ID)
  else plugins.disable(CI_INVESTIGATOR_PLUGIN_ID)
  setDefaultPluginRegistry(plugins)
  setGhAvailableForTest(gh)
  setSetting(SUBAGENTS_ENABLED_SETTING, subagents)
  setSetting('defaultReadonlyMode', readonly)
}

describe('isInvestigateCiOffered', () => {
  afterEach(() => {
    setDefaultPluginRegistry(null)
    setGhAvailableForTest(null)
    setSetting(SUBAGENTS_ENABLED_SETTING, false)
    setSetting('defaultReadonlyMode', false)
  })

  // Read-only mode is a fourth gate: parentTools drops every tool the read-only
  // allow-list does not name, and investigate_ci is not on it.
  for (const plugin of [false, true]) {
    for (const gh of [false, true]) {
      for (const subagents of [false, true]) {
        for (const readonly of [false, true]) {
          const expected = plugin && gh && subagents && !readonly
          it(`plugin=${String(plugin)} gh=${String(gh)} subagents=${String(subagents)} readonly=${String(readonly)} -> ${String(expected)}`, () => {
            arrange(plugin, gh, subagents, readonly)
            assert.equal(ciInvestigatorToolsRegistrable(), plugin && gh)
            assert.equal(isInvestigateCiOffered(), expected)
          })
        }
      }
    }
  }

  it('is not offered in read-only mode even when a caller passes subagents on', () => {
    arrange(true, true, true, true)
    assert.equal(isInvestigateCiOffered(true), false)
  })

  it('lets a caller pass the subagent flag it resolved for the turn', () => {
    arrange(true, true, false)
    assert.equal(isInvestigateCiOffered(true), true)
    arrange(true, true, true)
    assert.equal(isInvestigateCiOffered(false), false)
  })
})
