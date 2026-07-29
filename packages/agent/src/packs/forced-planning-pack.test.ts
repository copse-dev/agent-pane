// Contract test: the `copse.forced-planning` first-party pack.
//
// Landing invariants pinned here (mirrors pii-redaction-pack.test.ts):
//
// 1. **The pack is registered** in `FIRST_PARTY_PACKS` with id
//    `copse.forced-planning` and trust `first-party`, contributing exactly one
//    turn-start hook and no tools / prompt blocks / UI.
// 2. **No double-registration.** The hook is registered by the pack alone — it
//    is deliberately absent from the static `TURN_START_HOOKS` list, so the
//    registry never folds it in twice.
// 3. **Atomicity of disable.** One flag flip drops the hook from
//    `activeBlockingHooks()`; pack storage survives (decision 17).
// 4. **The manifest's settings schema matches the keys the hook reads**, so a
//    renamed setting fails here instead of silently reverting to the default.
// 5. **The steering names the real plan tool** — `forced-planning.ts` holds
//    `update_todos` as a literal to avoid an import cycle with the todos pack,
//    and this is what keeps that copy honest.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { forcedPlanningPack, FORCED_PLANNING_PACK_ID } from './forced-planning-pack.ts'
import { createFirstPartyPackRegistry, FIRST_PARTY_PACKS } from './first-party-packs.ts'
import { TODOS_TOOL_NAME } from './todos-pack.ts'
import { forcedPlanningHook, TURN_START_HOOKS } from '../hooks/turn-start-hooks.ts'
import {
  CANONICAL_THRESHOLD_SETTING,
  COMPOSITE_THRESHOLD_SETTING,
  DEFAULT_FORCED_PLANNING_CONFIG,
  PLAN_TOOL_NAME,
  UNMEASURED_MODEL_POLICIES,
  UNMEASURED_MODELS_SETTING,
} from '../forced-planning.ts'

describe('copse.forced-planning pack', () => {
  it('is registered in FIRST_PARTY_PACKS with id copse.forced-planning', () => {
    assert.equal(forcedPlanningPack.id, FORCED_PLANNING_PACK_ID)
    assert.equal(forcedPlanningPack.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PACKS.some((pack) => pack.id === FORCED_PLANNING_PACK_ID),
      'forced-planning pack must be part of the shipped first-party pack list',
    )
  })

  it('contributes only the turn-start hook and namespaced storage', () => {
    assert.deepEqual(forcedPlanningPack.contributions.blockingHooks, [forcedPlanningHook])
    assert.deepEqual(forcedPlanningPack.contributions.asyncHooks, [])
    assert.deepEqual(forcedPlanningPack.contributions.toolNames, [])
    assert.deepEqual(forcedPlanningPack.contributions.promptBlocks, [])
    assert.deepEqual(forcedPlanningPack.contributions.uiContributions, [])
    assert.deepEqual(forcedPlanningPack.manifest.storage, { namespace: FORCED_PLANNING_PACK_ID })
    assert.equal(forcedPlanningPack.manifest.tools, undefined)
  })

  it('registers the hook exactly once — the pack, never the static list', () => {
    assert.ok(
      !TURN_START_HOOKS.some((hook) => hook.id === forcedPlanningHook.id),
      'the pack owns this hook; leaving it in TURN_START_HOOKS would double-register it',
    )
    const occurrences = FIRST_PARTY_PACKS.flatMap((pack) =>
      pack.contributions.blockingHooks.map((hook) => hook.id),
    ).filter((id) => id === forcedPlanningHook.id)
    assert.equal(occurrences.length, 1)
  })

  it('declares the settings the hook reads, with the policy defaults', () => {
    const settings = forcedPlanningPack.manifest.settings
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

  it('names the same plan tool the todos pack contributes', () => {
    assert.equal(PLAN_TOOL_NAME, TODOS_TOOL_NAME)
  })

  it('atomically drops the hook from the active seed on disable', () => {
    const registry = createFirstPartyPackRegistry()
    assert.equal(registry.isEnabled(FORCED_PLANNING_PACK_ID), true)
    assert.ok(registry.activeBlockingHooks().some((hook) => hook.id === forcedPlanningHook.id))

    // Pack storage survives disable (decision 17).
    registry.storage(FORCED_PLANNING_PACK_ID).set('lastForcedThread', 't-1')

    registry.disable(FORCED_PLANNING_PACK_ID)
    assert.ok(
      !registry.activeBlockingHooks().some((hook) => hook.id === forcedPlanningHook.id),
      'the forced-planning hook must leave the assembly pipeline the moment the pack is disabled',
    )

    registry.enable(FORCED_PLANNING_PACK_ID)
    assert.ok(registry.activeBlockingHooks().some((hook) => hook.id === forcedPlanningHook.id))
    assert.equal(registry.storage(FORCED_PLANNING_PACK_ID).get('lastForcedThread'), 't-1')
  })
})
