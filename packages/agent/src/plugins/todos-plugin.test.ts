// Contract test: the `copse.todos` pilot plugin extracts the todos surface.
//
// P4 landing invariants pinned here (docs/plans/hooks-and-feature-packs.md,
// "Pilot plugin: todos"). Together they prove three things at once:
//
// 1. **The plugin owns every declared surface.** Tool name, turn-start + finalize
//    hooks, prompt block, and level-2 plan panel all live on the plugin's
//    manifest + runtime contributions — the acceptance list from the plan.
// 2. **Disabling removes them all atomically (decision 15/17).** One flag flip
//    on a shared `PluginRegistry` drops the tool from `activeToolNames`, the
//    hooks from `activeBlockingHooks`, the prompt block from
//    `activePromptBlocks`, and the panel from `activePanelContributions` —
//    with no partial state. Storage is untouched (decision 17).
// 3. **No double-registration (P4 trap).** The todo hooks used to be baked
//    into the static `FIRST_PARTY_HOOKS` list via `TURN_START_HOOKS` /
//    `BEFORE_FINALIZE_HOOKS`. If P4 forgot to remove them from those lists,
//    `createFirstPartyPluginRegistry() + FIRST_PARTY_HOOKS` would emit each todo
//    hook twice per turn — a silently duplicated `injectContext`. This test
//    asserts each todo hook id appears exactly once in the combined "hooks
//    that would register on a fresh loop" set.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  todosPlugin,
  TODOS_PLUGIN_ID,
  TODOS_PANEL_CONTRIBUTION_ID,
  TODOS_TOOL_NAME,
} from './todos-plugin.ts'
import { createFirstPartyPluginRegistry, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'
import { FIRST_PARTY_HOOKS } from '../hooks/hook-registry.ts'
import { TURN_START_HOOKS } from '../hooks/turn-start-hooks.ts'
import { BEFORE_FINALIZE_HOOKS } from '../hooks/before-finalize-hooks.ts'

describe('copse.todos plugin (P4)', () => {
  it('is registered in FIRST_PARTY_PLUGINS with id copse.todos', () => {
    assert.equal(todosPlugin.id, TODOS_PLUGIN_ID)
    assert.equal(todosPlugin.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PLUGINS.some((plugin) => plugin.id === TODOS_PLUGIN_ID),
      'todos plugin must be part of the shipped first-party plugin list',
    )
  })

  it('declares tool, hooks, prompt block, panel, and namespaced storage', () => {
    assert.deepEqual(todosPlugin.manifest.tools?.native, [TODOS_TOOL_NAME])
    assert.deepEqual(todosPlugin.manifest.storage, { namespace: TODOS_PLUGIN_ID })
    assert.deepEqual(
      todosPlugin.manifest.prompt?.map((block) => block.id),
      ['todo-steering-block'],
    )
    const panelSlot = todosPlugin.manifest.ui?.find((c) => c.id === TODOS_PANEL_CONTRIBUTION_ID)
    assert.ok(panelSlot, 'plan panel contribution must be declared in the manifest')
    assert.equal(panelSlot.level, 2)
    assert.deepEqual(panelSlot.panel, {
      kind: 'list',
      header: 'To-dos',
      ariaLabel: 'To-dos',
    })
  })

  it('contributes the three typed function hooks the plan calls out', () => {
    // The plan lists todo-steering + todo-pin (turn start) and todo-closeout
    // (`beforeFinalize`); `todo-compact-pin` (compaction) is not yet wired to
    // the loop — the compaction hook lands with the later E-phase work that
    // adds the `compaction` async event fire site. The plugin's runtime
    // contribution list holds the three current hooks in the order they
    // register (assembly order is load-bearing for `todo-steering` before
    // `todo-pin`).
    assert.deepEqual(
      todosPlugin.contributions.blockingHooks.map((hook) => hook.id),
      ['todo-steering', 'todo-pin', 'todo-finalize-closeout'],
    )
    assert.deepEqual(todosPlugin.contributions.toolNames, [TODOS_TOOL_NAME])
    assert.deepEqual(
      todosPlugin.contributions.uiContributions.map((c) => c.id),
      [TODOS_PANEL_CONTRIBUTION_ID],
    )
  })

  it('P4 trap — todos hooks removed from the static FIRST_PARTY_HOOKS list', () => {
    // The plugin folds its hooks in through `createHookRegistry`; if they also
    // survived in the static M0 list, every turn would register them twice.
    // Guard the class of mistake: no todo-* id may appear on either static
    // list, and the combined set (static + plugin contributions) must contain
    // each todo hook exactly once.
    const staticIds = new Set([
      ...TURN_START_HOOKS.map((hook) => hook.id),
      ...BEFORE_FINALIZE_HOOKS.map((hook) => hook.id),
      ...FIRST_PARTY_HOOKS.map((hook) => hook.id),
    ])
    for (const id of ['todo-steering', 'todo-pin', 'todo-finalize-closeout']) {
      assert.ok(!staticIds.has(id), `static hook lists must not still carry "${id}" post-P4`)
    }

    const combined = [
      ...FIRST_PARTY_HOOKS.map((hook) => hook.id),
      ...todosPlugin.contributions.blockingHooks.map((hook) => hook.id),
    ]
    for (const id of ['todo-steering', 'todo-pin', 'todo-finalize-closeout']) {
      const occurrences = combined.filter((entry) => entry === id).length
      assert.equal(occurrences, 1, `${id} must register exactly once (loop + plugin combined)`)
    }
  })

  it('disabling the plugin atomically drops tool + hooks + prompt + panel', () => {
    // Pinned end-to-end: from the shipped seed, one flag flip must clear
    // every one of the todos plugin's contribution kinds. P5 added two more
    // first-party plugins (`copse.post-turn-review` and `copse.model-comparison`)
    // that ship enabled — so this test asserts specifically that the *todos*
    // plugin's own contributions leave the active set on disable, not that the
    // whole registry drops to zero. The sibling plugins' state is unaffected.
    const registry = createFirstPartyPluginRegistry()
    assert.ok(registry.activeToolNames().includes(TODOS_TOOL_NAME))
    assert.ok(registry.activeBlockingHooks().some((hook) => hook.id === 'todo-steering'))
    assert.ok(registry.activePromptBlocks().some((block) => block.id === 'todo-steering-block'))
    assert.ok(
      registry
        .activePanelContributions()
        .some(
          ({ pluginId, contribution }) =>
            pluginId === TODOS_PLUGIN_ID && contribution.id === TODOS_PANEL_CONTRIBUTION_ID,
        ),
    )

    registry.disable(TODOS_PLUGIN_ID)

    assert.ok(
      !registry.activeToolNames().includes(TODOS_TOOL_NAME),
      'todos tool must leave activeToolNames() atomically on plugin disable',
    )
    assert.ok(
      !registry.activeBlockingHooks().some((hook) => hook.id === 'todo-steering'),
      'todo-steering hook must leave activeBlockingHooks() atomically on plugin disable',
    )
    assert.ok(
      !registry.activePromptBlocks().some((block) => block.id === 'todo-steering-block'),
      'todo steering prompt block must leave activePromptBlocks() atomically on plugin disable',
    )
    assert.ok(
      !registry.activePanelContributions().some(({ pluginId }) => pluginId === TODOS_PLUGIN_ID),
      'plan panel contribution must leave activePanelContributions() atomically on plugin disable',
    )

    // Plugin storage survives the disable (decision 17); use it and confirm it
    // is intact after re-enabling.
    registry.storage(TODOS_PLUGIN_ID).set('lastPlan', 'p-1')
    registry.enable(TODOS_PLUGIN_ID)
    assert.equal(registry.storage(TODOS_PLUGIN_ID).get('lastPlan'), 'p-1')
    assert.ok(registry.activeToolNames().includes(TODOS_TOOL_NAME))
  })
})
