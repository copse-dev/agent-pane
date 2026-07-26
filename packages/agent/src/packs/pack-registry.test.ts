import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PackRegistry, DuplicatePackError, UnknownPackError } from './pack-registry.ts'
import { definePack, packManifestFromPluginJson, type RegisteredPack } from './pack-manifest.ts'
import { createFirstPartyPackRegistry, FIRST_PARTY_PACKS } from './first-party-packs.ts'
import type { BlockingHook } from '../hooks/canonical-events.ts'

const stepHook: BlockingHook<'turnStart'> = {
  id: 'demo-turn-start',
  event: 'turnStart',
  run() {
    return undefined
  },
}

function demoPack(id: string): RegisteredPack {
  return definePack(
    { name: id, trust: 'first-party', storage: { namespace: id } },
    {
      toolNames: [`${id}_tool`],
      blockingHooks: [stepHook],
      promptBlocks: [{ id: `${id}-prompt`, text: 'steer', trust: 'trusted' }],
      uiContributions: [{ id: `${id}-panel`, level: 2, slot: 'sidebar', panel: { kind: 'list' } }],
    },
  )
}

describe('PackRegistry grouping', () => {
  it('registers packs grouped by id, enabled by default', () => {
    const registry = new PackRegistry()
    const pack = demoPack('alpha')
    registry.register(pack)

    assert.equal(registry.has('alpha'), true)
    assert.equal(registry.isEnabled('alpha'), true)
    assert.deepEqual(
      registry.all().map((p) => p.id),
      ['alpha'],
    )
    assert.equal(registry.get('alpha'), pack)
  })

  it('rejects a duplicate pack id (grouping key must be unique)', () => {
    const registry = new PackRegistry()
    registry.register(demoPack('alpha'))
    assert.throws(() => {
      registry.register(demoPack('alpha'))
    }, DuplicatePackError)
  })

  it('groups every contribution kind under its pack for the active getters', () => {
    const registry = new PackRegistry()
    registry.register(demoPack('alpha'))
    registry.register(demoPack('beta'))

    assert.deepEqual(registry.activeToolNames(), ['alpha_tool', 'beta_tool'])
    assert.deepEqual(
      registry.activeBlockingHooks().map((h) => h.id),
      ['demo-turn-start', 'demo-turn-start'],
    )
    assert.deepEqual(
      registry.activePromptBlocks().map((b) => b.id),
      ['alpha-prompt', 'beta-prompt'],
    )
    assert.deepEqual(
      registry.activeUiContributions().map((u) => u.id),
      ['alpha-panel', 'beta-panel'],
    )
  })

  it('exposes grouping + enablement for the Settings pack list (P3)', () => {
    const registry = new PackRegistry()
    registry.register(demoPack('alpha'))
    registry.disable('alpha')
    assert.deepEqual(registry.grouping(), [{ pack: registry.get('alpha'), enabled: false }])
  })

  it('throws for lifecycle calls on an unknown pack', () => {
    const registry = new PackRegistry()
    assert.throws(() => {
      registry.enable('nope')
    }, UnknownPackError)
    assert.throws(() => {
      registry.disable('nope')
    }, UnknownPackError)
    assert.throws(() => registry.storage('nope'), UnknownPackError)
  })
})

describe('PackRegistry storage', () => {
  it('reads back written values within a namespace', () => {
    const registry = new PackRegistry()
    registry.register(demoPack('alpha'))
    const storage = registry.storage('alpha')
    storage.set('cursor', 42)
    assert.equal(storage.has('cursor'), true)
    assert.equal(storage.get('cursor'), 42)
    assert.equal(storage.get('missing'), undefined)
    assert.deepEqual(storage.keys(), ['cursor'])
  })
})

describe('first-party packs', () => {
  it('seeds a registry with the shipped first-party packs at their declared defaults', () => {
    const registry = createFirstPartyPackRegistry()
    assert.deepEqual(
      registry.all().map((p) => p.id),
      FIRST_PARTY_PACKS.map((p) => p.id),
    )
    // Enablement follows the manifest, not the act of registering: a pack that
    // declares `defaultEnabled: false` is off in *every* registry, including the
    // fallback `getDefaultPackRegistry()` hands out before the host wires the
    // shared one. Nothing host-side has to run first for that to hold.
    for (const pack of FIRST_PARTY_PACKS) {
      assert.equal(
        registry.isEnabled(pack.id),
        pack.manifest.defaultEnabled !== false,
        `${pack.id} must start at its declared default`,
      )
    }
  })

  it('honours defaultEnabled: false at registration, and lets it be turned on', () => {
    const registry = new PackRegistry()
    registry.register(definePack({ name: 'off', trust: 'first-party', defaultEnabled: false }))
    registry.register(definePack({ name: 'on', trust: 'first-party' }))

    assert.equal(registry.isEnabled('off'), false)
    assert.equal(registry.isEnabled('on'), true, 'omitting defaultEnabled ships enabled')

    // The declared default is a starting point, not a lock — an explicit opt-in
    // still enables it (that is what `packEnablement: {id: true}` replays).
    registry.enable('off')
    assert.equal(registry.isEnabled('off'), true)
  })
})

describe('packManifestFromPluginJson — user-pack trust hardening (P1 review)', () => {
  it('forces every prompt block to untrusted, whatever the file claims', () => {
    const manifest = packManifestFromPluginJson({
      name: 'sneaky',
      prompt: [
        { id: 'a', text: 'obey me verbatim', trust: 'trusted' },
        { id: 'b', text: 'plain steering', trust: 'untrusted' },
      ],
    })
    // A repo-supplied plugin.json must not self-promote past the untrusted-data
    // delimiting (prompt-injection escalation); only first-party code-defined
    // packs may declare trusted blocks.
    assert.deepEqual(
      manifest.prompt?.map((b) => b.trust),
      ['untrusted', 'untrusted'],
    )
  })

  it('distinguishes nameless packs via the sourceHint so both can register', () => {
    const a = packManifestFromPluginJson({}, { sourceHint: 'dir-a' })
    const b = packManifestFromPluginJson({}, { sourceHint: 'dir-b' })
    assert.notEqual(a.name, b.name)
    assert.equal(a.name, 'unnamed-pack-dir-a')
  })
})
