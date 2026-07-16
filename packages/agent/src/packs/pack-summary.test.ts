// Pack-summary projection — P3 (docs/plans/hooks-and-feature-packs.md).
//
// The Settings pack list renders `PackSummaryOut` snapshots that
// `summarizePacks` produces from the shared `PackRegistry` + a per-key reader.
// The invariants this pins:
//  - contributions carry through with the right shapes (tools / hooks / prompt
//    / panel-kind / storage namespace);
//  - the `enabled` flag reflects the registry's current state;
//  - setting values are coerced to their declared kind, falling back to the
//    declared default when nothing is stored.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PackRegistry } from './pack-registry.ts'
import { definePack, type PackSettingsSchema, type RegisteredPack } from './pack-manifest.ts'
import type { BlockingHook } from '../hooks/canonical-events.ts'
import { normalizePackSettingValue, packToSummary, summarizePacks } from './pack-summary.ts'

const stepHook: BlockingHook<'turnStart'> = {
  id: 'demo-turn-start',
  event: 'turnStart',
  run() {
    return undefined
  },
}

const demoSettings: PackSettingsSchema = {
  enabled: { kind: 'boolean', title: 'Enabled', default: true },
  budgetPerTurn: {
    kind: 'number',
    title: 'Budget per turn',
    default: 3,
  },
  mode: {
    kind: 'enum',
    title: 'Mode',
    default: 'strict',
    options: ['strict', 'relaxed'],
  },
  label: { kind: 'string', title: 'Label', default: 'hello' },
}

function demoPack(id: string): RegisteredPack {
  return definePack(
    {
      name: id,
      trust: 'first-party',
      description: `demo ${id}`,
      version: '1.2.3',
      storage: { namespace: id },
      settings: demoSettings,
      tools: { native: [`${id}_tool`] },
      hooks: [{ event: 'toolGate', command: './noop.sh' }],
    },
    {
      toolNames: [`${id}_tool`],
      blockingHooks: [stepHook],
      promptBlocks: [{ id: `${id}-prompt`, text: 'steer', trust: 'trusted' }],
      uiContributions: [
        { id: `${id}-panel`, level: 2, slot: 'sidebar', title: 'Sidebar', panel: { kind: 'list' } },
      ],
    },
  )
}

describe('packToSummary', () => {
  it('enumerates contributions and manifest metadata', () => {
    const pack = demoPack('alpha')
    const summary = packToSummary(pack, true, () => undefined)
    assert.equal(summary.id, 'alpha')
    assert.equal(summary.trust, 'first-party')
    assert.equal(summary.enabled, true)
    assert.equal(summary.version, '1.2.3')
    assert.equal(summary.description, 'demo alpha')
    assert.deepEqual(summary.contributions.toolNames, ['alpha_tool'])
    assert.deepEqual(summary.contributions.blockingHooks, [
      { id: 'demo-turn-start', event: 'turnStart' },
    ])
    assert.deepEqual(summary.contributions.commandHooks, [
      { event: 'toolGate', command: './noop.sh' },
    ])
    assert.deepEqual(summary.contributions.promptBlocks, [{ id: 'alpha-prompt', trust: 'trusted' }])
    assert.deepEqual(summary.contributions.ui, [
      { id: 'alpha-panel', level: 2, slot: 'sidebar', title: 'Sidebar', panelKind: 'list' },
    ])
    assert.equal(summary.contributions.storageNamespace, 'alpha')
  })

  it('falls values back to declared defaults when nothing is stored', () => {
    const pack = demoPack('alpha')
    const summary = packToSummary(pack, true, () => undefined)
    const byId = Object.fromEntries(summary.settings.map((f) => [f.id, f.value]))
    assert.deepEqual(byId, {
      enabled: true,
      budgetPerTurn: 3,
      mode: 'strict',
      label: 'hello',
    })
  })

  it('surfaces persisted values in the correct kind', () => {
    const pack = demoPack('alpha')
    const stored: Record<string, unknown> = {
      enabled: false,
      budgetPerTurn: 7,
      mode: 'relaxed',
      label: 'from-disk',
    }
    const summary = packToSummary(pack, true, (key) => stored[key])
    const byId = Object.fromEntries(summary.settings.map((f) => [f.id, f.value]))
    assert.deepEqual(byId, {
      enabled: false,
      budgetPerTurn: 7,
      mode: 'relaxed',
      label: 'from-disk',
    })
  })

  it('coerces the wrong stored kind back to its default (defensive)', () => {
    const pack = demoPack('alpha')
    const stored: Record<string, unknown> = {
      enabled: 'not-a-bool',
      budgetPerTurn: 'seven',
      mode: 'unknown',
    }
    const summary = packToSummary(pack, true, (key) => stored[key])
    const byId = Object.fromEntries(summary.settings.map((f) => [f.id, f.value]))
    assert.equal(byId['enabled'], true)
    assert.equal(byId['budgetPerTurn'], 3)
    assert.equal(byId['mode'], 'strict')
  })
})

describe('summarizePacks', () => {
  it('reflects disable → enabled=false on the summary', () => {
    const registry = new PackRegistry()
    registry.register(demoPack('alpha'))
    registry.register(demoPack('beta'))
    registry.disable('beta')

    const packs = summarizePacks(registry, () => undefined)
    const byId = Object.fromEntries(packs.map((p) => [p.id, p.enabled]))
    assert.deepEqual(byId, { alpha: true, beta: false })
  })

  it('threads (packId, key) into the reader per pack', () => {
    const registry = new PackRegistry()
    registry.register(demoPack('alpha'))
    registry.register(demoPack('beta'))
    const seen: string[] = []
    summarizePacks(registry, (packId, key) => {
      seen.push(`${packId}.${key}`)
      return undefined
    })
    // Each pack asks its own reader for each declared field, so key namespaces
    // stay pack-scoped (no aliasing possible on the persistence backend).
    assert.ok(seen.includes('alpha.enabled'))
    assert.ok(seen.includes('beta.enabled'))
  })
})

describe('normalizePackSettingValue', () => {
  it('picks the first enum option when default is missing and stored is wrong', () => {
    const value = normalizePackSettingValue(
      { kind: 'enum', title: 'x', options: ['a', 'b'] },
      'not-in-list',
    )
    assert.equal(value, 'a')
  })
})
