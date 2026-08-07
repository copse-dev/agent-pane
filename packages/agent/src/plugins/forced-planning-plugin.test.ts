// Contract test: the `copse.forced-planning` first-party plugin.
//
// Landing invariants pinned here (mirrors pii-redaction-plugin.test.ts):
//
// 1. **The plugin is registered** in `FIRST_PARTY_PLUGINS` with id
//    `copse.forced-planning` and trust `first-party`, contributing exactly one
//    turn-start hook and no tools / prompt blocks / UI.
// 2. **No double-registration.** The hook is registered by the plugin alone — it
//    is deliberately absent from the static `TURN_START_HOOKS` list, so the
//    registry never folds it in twice.
// 3. **Atomicity of disable.** One flag flip drops the hook from
//    `activeBlockingHooks()`; plugin storage survives (decision 17).
// 4. **The manifest's settings schema matches the keys the hook reads**, so a
//    renamed setting fails here instead of silently reverting to the default.
// 5. **The steering names the real plan tool** — `forced-planning.ts` holds
//    `update_todos` as a literal to avoid an import cycle with the todos plugin,
//    and this is what keeps that copy honest.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { forcedPlanningPlugin, FORCED_PLANNING_PLUGIN_ID } from './forced-planning-plugin.ts'
import { createFirstPartyPluginRegistry, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'
import { TODOS_TOOL_NAME } from './todos-plugin.ts'
import { forcedPlanningHook, TURN_START_HOOKS } from '../hooks/turn-start-hooks.ts'
import {
  CANONICAL_THRESHOLD_SETTING,
  COMPOSITE_THRESHOLD_SETTING,
  DEFAULT_FORCED_PLANNING_CONFIG,
  PLAN_TOOL_NAME,
  UNMEASURED_MODEL_POLICIES,
  UNMEASURED_MODELS_SETTING,
} from '../forced-planning.ts'

describe('copse.forced-planning plugin', () => {
  it('is registered in FIRST_PARTY_PLUGINS with id copse.forced-planning', () => {
    assert.equal(forcedPlanningPlugin.id, FORCED_PLANNING_PLUGIN_ID)
    assert.equal(forcedPlanningPlugin.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PLUGINS.some((plugin) => plugin.id === FORCED_PLANNING_PLUGIN_ID),
      'forced-planning plugin must be part of the shipped first-party plugin list',
    )
  })

  it('contributes only the turn-start hook and namespaced storage', () => {
    assert.deepEqual(forcedPlanningPlugin.contributions.blockingHooks, [forcedPlanningHook])
    assert.deepEqual(forcedPlanningPlugin.contributions.asyncHooks, [])
    assert.deepEqual(forcedPlanningPlugin.contributions.toolNames, [])
    assert.deepEqual(forcedPlanningPlugin.contributions.promptBlocks, [])
    assert.deepEqual(forcedPlanningPlugin.contributions.uiContributions, [])
    assert.deepEqual(forcedPlanningPlugin.manifest.storage, {
      namespace: FORCED_PLANNING_PLUGIN_ID,
    })
    assert.equal(forcedPlanningPlugin.manifest.tools, undefined)
  })

  it('registers the hook exactly once — the plugin, never the static list', () => {
    assert.ok(
      !TURN_START_HOOKS.some((hook) => hook.id === forcedPlanningHook.id),
      'the plugin owns this hook; leaving it in TURN_START_HOOKS would double-register it',
    )
    const occurrences = FIRST_PARTY_PLUGINS.flatMap((plugin) =>
      plugin.contributions.blockingHooks.map((hook) => hook.id),
    ).filter((id) => id === forcedPlanningHook.id)
    assert.equal(occurrences.length, 1)
  })

  it('declares the settings the hook reads, with the policy defaults', () => {
    const settings = forcedPlanningPlugin.manifest.settings
    assert.ok(settings)
    assert.deepEqual(
      Object.keys(settings).sort(),
      [CANONICAL_THRESHOLD_SETTING, COMPOSITE_THRESHOLD_SETTING, UNMEASURED_MODELS_SETTING].sort(),
    )
    assert.equal(
      settings[CANONICAL_THRESHOLD_SETTING]?.default,
      DEFAULT_FORCED_PLANNING_CONFIG.canonicalThreshold,
    )
    assert.equal(
      settings[COMPOSITE_THRESHOLD_SETTING]?.default,
      DEFAULT_FORCED_PLANNING_CONFIG.compositeThreshold,
    )
    const unmeasuredField = settings[UNMEASURED_MODELS_SETTING]
    assert.ok(unmeasuredField)
    assert.equal(unmeasuredField.default, DEFAULT_FORCED_PLANNING_CONFIG.unmeasured)
    assert.deepEqual(unmeasuredField.options, UNMEASURED_MODEL_POLICIES)
  })

  it('names the same plan tool the todos plugin contributes', () => {
    assert.equal(PLAN_TOOL_NAME, TODOS_TOOL_NAME)
  })

  it('atomically drops the hook from the active seed on disable', () => {
    const registry = createFirstPartyPluginRegistry()
    assert.equal(registry.isEnabled(FORCED_PLANNING_PLUGIN_ID), true)
    assert.ok(registry.activeBlockingHooks().some((hook) => hook.id === forcedPlanningHook.id))

    // Plugin storage survives disable (decision 17).
    registry.storage(FORCED_PLANNING_PLUGIN_ID).set('lastForcedThread', 't-1')

    registry.disable(FORCED_PLANNING_PLUGIN_ID)
    assert.ok(
      !registry.activeBlockingHooks().some((hook) => hook.id === forcedPlanningHook.id),
      'the forced-planning hook must leave the assembly pipeline the moment the plugin is disabled',
    )

    registry.enable(FORCED_PLANNING_PLUGIN_ID)
    assert.ok(registry.activeBlockingHooks().some((hook) => hook.id === forcedPlanningHook.id))
    assert.equal(registry.storage(FORCED_PLANNING_PLUGIN_ID).get('lastForcedThread'), 't-1')
  })
})
