// Default-plugin-registry provider — P3 (docs/plans/hooks-and-feature-packs.md).
//
// `createHookRegistry` reads the shared plugin registry through this provider so
// a persisted enable/disable flip on the host takes effect in the loop
// atomically (P1 contract) — without threading a `PluginRegistry` through every
// caller. This test pins two invariants: (1) the fallback (no host wiring)
// still returns a first-party seed, so tests and the P1 byte-identical
// behavior are preserved; (2) once installed, `createHookRegistry` sees the
// same instance and therefore inherits any disable already applied to it.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getDefaultPluginRegistry, setDefaultPluginRegistry } from './default-plugin-registry.ts'
import { PluginRegistry } from './plugin-registry.ts'
import { definePlugin, type RegisteredPlugin } from './plugin-manifest.ts'
import type { BlockingHook } from '../hooks/canonical-events.ts'
import { createHookRegistry } from '../hooks/hook-registry.ts'
import { FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'
import { TODOS_PLUGIN_ID } from './todos-plugin.ts'

const pluginHook: BlockingHook<'turnStart'> = {
  id: 'shared-plugin-hook',
  event: 'turnStart',
  run() {
    return undefined
  },
}

function pluginWithHook(): RegisteredPlugin {
  return definePlugin(
    {
      name: 'shared-plugin',
      trust: 'first-party',
      stability: 'stable',
      storage: { namespace: 'shared-plugin' },
    },
    { blockingHooks: [pluginHook] },
  )
}

describe('default plugin registry provider (P3)', () => {
  afterEach(() => {
    setDefaultPluginRegistry(null)
  })

  it('falls back to a fresh first-party seed when nothing is installed', () => {
    const registry = getDefaultPluginRegistry()
    assert.deepEqual(
      registry.all().map((p) => p.id),
      FIRST_PARTY_PLUGINS.map((p) => p.id),
    )
    // The fallback carries the same real first-party plugins as the host-wired
    // registry, so unwired callers still see shipped tools and hooks.
    assert.ok(registry.has(TODOS_PLUGIN_ID))

    // Two consecutive fallback reads return two *different* registry instances
    // (a fresh seed each call). This is the tell that the fallback is not a
    // shared singleton: installing a plugin must not leak into later unwired
    // callers.
    const other = getDefaultPluginRegistry()
    assert.notEqual(other, registry)
  })

  it('createHookRegistry consults the installed shared registry (atomic disable)', () => {
    const shared = new PluginRegistry()
    shared.register(pluginWithHook())
    setDefaultPluginRegistry(shared)

    // Enabled → the plugin's hook is folded into new work.
    const enabled = createHookRegistry([])
    assert.deepEqual(
      enabled.hooksFor('turnStart').map((h) => h.id),
      ['shared-plugin-hook'],
    )

    // Flip the shared registry's flag: the next `createHookRegistry` call
    // sees an empty active hook set — no re-wiring of the loop required.
    shared.disable('shared-plugin')
    const disabled = createHookRegistry([])
    assert.deepEqual(disabled.hooksFor('turnStart'), [])
  })
})
