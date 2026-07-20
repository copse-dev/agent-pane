// Default-pack-registry provider — P3 (docs/plans/hooks-and-feature-packs.md).
//
// `createHookRegistry` reads the shared pack registry through this provider so
// a persisted enable/disable flip on the host takes effect in the loop
// atomically (P1 contract) — without threading a `PackRegistry` through every
// caller. This test pins two invariants: (1) the fallback (no host wiring)
// still returns a first-party seed, so tests and the P1 byte-identical
// behavior are preserved; (2) once installed, `createHookRegistry` sees the
// same instance and therefore inherits any disable already applied to it.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getDefaultPackRegistry, setDefaultPackRegistry } from './default-pack-registry.ts'
import { PackRegistry } from './pack-registry.ts'
import { definePack, type RegisteredPack } from './pack-manifest.ts'
import type { BlockingHook } from '../hooks/canonical-events.ts'
import { createHookRegistry } from '../hooks/hook-registry.ts'
import { FIRST_PARTY_PACKS, noopPack } from './first-party-packs.ts'

const packHook: BlockingHook<'turnStart'> = {
  id: 'shared-pack-hook',
  event: 'turnStart',
  run() {
    return undefined
  },
}

function packWithHook(): RegisteredPack {
  return definePack(
    { name: 'shared-pack', trust: 'first-party', storage: { namespace: 'shared-pack' } },
    { blockingHooks: [packHook] },
  )
}

describe('default pack registry provider (P3)', () => {
  afterEach(() => {
    setDefaultPackRegistry(null)
  })

  it('falls back to a fresh first-party seed when nothing is installed', () => {
    const registry = getDefaultPackRegistry()
    assert.deepEqual(
      registry.all().map((p) => p.id),
      FIRST_PARTY_PACKS.map((p) => p.id),
    )
    // The skeleton `copse.noop` pack ships as the seed — the fallback is not
    // an empty registry, so unwired callers see the same tools/hooks P1 wired.
    assert.ok(registry.has(noopPack.id))

    // Two consecutive fallback reads return two *different* registry instances
    // (a fresh seed each call). This is the tell that the fallback is not a
    // shared singleton: installing a pack must not leak into later unwired
    // callers.
    const other = getDefaultPackRegistry()
    assert.notEqual(other, registry)
  })

  it('createHookRegistry consults the installed shared registry (atomic disable)', () => {
    const shared = new PackRegistry()
    shared.register(packWithHook())
    setDefaultPackRegistry(shared)

    // Enabled → the pack's hook is folded into new work.
    const enabled = createHookRegistry([])
    assert.deepEqual(
      enabled.hooksFor('turnStart').map((h) => h.id),
      ['shared-pack-hook'],
    )

    // Flip the shared registry's flag: the next `createHookRegistry` call
    // sees an empty active hook set — no re-wiring of the loop required.
    shared.disable('shared-pack')
    const disabled = createHookRegistry([])
    assert.deepEqual(disabled.hooksFor('turnStart'), [])
  })
})
