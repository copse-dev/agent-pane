// Level-2 panel contributions in the registry (P2).
//
// Pins two invariants that make the panel primitive safe to build P4 on:
//  1. A level-2 UI contribution *must* declare its panel shape at registration
//     — the host has nothing to validate `panel_update` against otherwise.
//     `InvalidPanelContributionError` fires at register time, not at first
//     emit, so the failure is discoverable during plugin authoring.
//  2. Disabling the owning plugin drops its panel from the active getters in one
//     action, alongside its tools / hooks / prompt / other UI (decision 15
//     atomicity). History is unaffected because history renders from spine
//     data, never the registry (decision 17) — pinned separately in
//     `history-never-consults-live-registration.test.ts`.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { definePlugin } from './plugin-manifest.ts'
import { InvalidPanelContributionError, PluginRegistry } from './plugin-registry.ts'

describe('level-2 panel contributions', () => {
  it('registers a plugin with a valid level-2 panel and surfaces it in activePanelContributions()', () => {
    const registry = new PluginRegistry()
    const plugin = definePlugin(
      {
        name: 'todos-demo',
        trust: 'first-party',
        stability: 'stable',
        storage: { namespace: 'todos-demo' },
      },
      {
        uiContributions: [
          {
            id: 'todos-panel',
            level: 2,
            slot: 'plan',
            title: 'To-dos',
            panel: { kind: 'list', header: 'To-dos' },
          },
        ],
      },
    )
    registry.register(plugin)

    const panels = registry.activePanelContributions()
    assert.equal(panels.length, 1)
    const first = panels[0]
    assert.ok(first, 'expected one active panel contribution')
    assert.equal(first.pluginId, 'todos-demo')
    assert.equal(first.contribution.id, 'todos-panel')
    assert.equal(first.contribution.panel?.kind, 'list')
  })

  it('rejects a level-2 contribution without a panel decl at register time', () => {
    const registry = new PluginRegistry()
    const bad = definePlugin(
      { name: 'broken', trust: 'first-party', stability: 'stable' },
      {
        uiContributions: [{ id: 'orphan-panel', level: 2, slot: 'plan' }],
      },
    )
    assert.throws(() => {
      registry.register(bad)
    }, InvalidPanelContributionError)
    // Registration must not have partially applied — the whole plugin is rejected.
    assert.equal(registry.has('broken'), false)
  })

  it('rejects a panel decl on a non-level-2 contribution at register time', () => {
    const registry = new PluginRegistry()
    const bad = definePlugin(
      { name: 'mislevelled', trust: 'first-party', stability: 'stable' },
      {
        uiContributions: [{ id: 'card-with-panel', level: 1, panel: { kind: 'list' } }],
      },
    )
    // A typo'd level must fail loudly, not ship a panel the host silently
    // ignores — panels are the level-2 contract.
    assert.throws(() => {
      registry.register(bad)
    }, InvalidPanelContributionError)
    assert.equal(registry.has('mislevelled'), false)
  })

  it('allows level-1 (cards) and level-3 (real views) without a panel decl', () => {
    const registry = new PluginRegistry()
    const ok = definePlugin(
      { name: 'mixed', trust: 'first-party', stability: 'stable' },
      {
        uiContributions: [
          { id: 'hook-card', level: 1 },
          { id: 'plan-view', level: 3, slot: 'plan', title: 'Plan' },
        ],
      },
    )
    registry.register(ok)
    assert.equal(registry.has('mixed'), true)
    assert.deepEqual(registry.activePanelContributions(), [])
  })

  it('drops the panel from activePanelContributions() when the plugin is disabled (atomicity)', () => {
    const registry = new PluginRegistry()
    registry.register(
      definePlugin(
        { name: 'todos', trust: 'first-party', stability: 'stable' },
        {
          uiContributions: [{ id: 'todos-panel', level: 2, slot: 'plan', panel: { kind: 'list' } }],
        },
      ),
    )
    assert.equal(registry.activePanelContributions().length, 1)

    registry.disable('todos')
    assert.deepEqual(registry.activePanelContributions(), [])
    // Re-enabling restores the panel — declaration wasn't lost.
    registry.enable('todos')
    assert.equal(registry.activePanelContributions().length, 1)
  })

  it('groups multiple plugins deterministically in registration order', () => {
    const registry = new PluginRegistry()
    registry.register(
      definePlugin(
        { name: 'alpha', trust: 'first-party', stability: 'stable' },
        {
          uiContributions: [{ id: 'alpha-panel', level: 2, slot: 'plan', panel: { kind: 'list' } }],
        },
      ),
    )
    registry.register(
      definePlugin(
        { name: 'beta', trust: 'first-party', stability: 'stable' },
        {
          uiContributions: [
            { id: 'beta-panel', level: 2, slot: 'sidebar', panel: { kind: 'tree' } },
          ],
        },
      ),
    )
    assert.deepEqual(
      registry.activePanelContributions().map((p) => `${p.pluginId}/${p.contribution.id}`),
      ['alpha/alpha-panel', 'beta/beta-panel'],
    )
  })
})
