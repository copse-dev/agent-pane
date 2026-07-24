// Contract test: atomic enable/disable (P1, decision 15/17 disable semantics).
//
// Disabling a pack must remove *every* contribution kind from new work in one
// action — tools leave the model tool list, hooks stop firing, prompt blocks
// drop out, UI stops mounting — with no partial state, while pack storage
// persists. Re-enabling restores the contributions and the storage is intact.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PackRegistry } from './pack-registry.ts'
import { definePack, type RegisteredPack } from './pack-manifest.ts'
import type { AsyncHook, BlockingHook } from '../hooks/canonical-events.ts'

const blockingHook: BlockingHook<'turnStart'> = {
  id: 'pilot-turn-start',
  event: 'turnStart',
  run() {
    return undefined
  },
}

const asyncHook: AsyncHook<'stop'> = {
  id: 'pilot-stop',
  event: 'stop',
  run() {
    return undefined
  },
}

function pilotPack(): RegisteredPack {
  return definePack(
    { name: 'pilot', trust: 'first-party', storage: { namespace: 'pilot' } },
    {
      toolNames: ['update_todos'],
      blockingHooks: [blockingHook],
      asyncHooks: [asyncHook],
      promptBlocks: [{ id: 'pilot-steer', text: 'plan your work', trust: 'trusted' }],
      uiContributions: [{ id: 'pilot-plan-panel', level: 3, slot: 'plan' }],
      capabilities: [{ name: 'pilot-flag', title: 'Pilot flag' }],
    },
  )
}

function activeCounts(registry: PackRegistry): Record<string, number> {
  return {
    tools: registry.activeToolNames().length,
    blocking: registry.activeBlockingHooks().length,
    async: registry.activeAsyncHooks().length,
    prompt: registry.activePromptBlocks().length,
    ui: registry.activeUiContributions().length,
    capabilities: registry.activeCapabilities().length,
  }
}

describe('atomic enable/disable', () => {
  it('drops all contribution kinds in one disable, with no partial state', () => {
    const registry = new PackRegistry()
    registry.register(pilotPack())

    assert.deepEqual(activeCounts(registry), {
      tools: 1,
      blocking: 1,
      async: 1,
      prompt: 1,
      ui: 1,
      capabilities: 1,
    })
    // The capability is active while the owning pack is enabled.
    assert.equal(registry.isCapabilityActive('pilot-flag'), true)

    registry.disable('pilot')

    // Every kind is gone at once — the whole point of atomicity.
    assert.equal(registry.isEnabled('pilot'), false)
    assert.deepEqual(activeCounts(registry), {
      tools: 0,
      blocking: 0,
      async: 0,
      prompt: 0,
      ui: 0,
      capabilities: 0,
    })
    // Disabling drops the capability in the same flag flip (mirrors the tool-name
    // assertion): `isCapabilityActive` is the single seam subsystems consult.
    assert.equal(registry.isCapabilityActive('pilot-flag'), false)
  })

  it('restores every contribution kind on re-enable', () => {
    const registry = new PackRegistry()
    registry.register(pilotPack())
    registry.disable('pilot')
    registry.enable('pilot')

    assert.equal(registry.isEnabled('pilot'), true)
    assert.deepEqual(activeCounts(registry), {
      tools: 1,
      blocking: 1,
      async: 1,
      prompt: 1,
      ui: 1,
      capabilities: 1,
    })
    assert.equal(registry.isCapabilityActive('pilot-flag'), true)
  })

  it('leaves only the disabled pack removed from a mixed registry', () => {
    const registry = new PackRegistry()
    registry.register(pilotPack())
    registry.register(
      definePack(
        { name: 'other', trust: 'first-party' },
        { toolNames: ['other_tool'], promptBlocks: [{ id: 'o', text: 'x', trust: 'trusted' }] },
      ),
    )

    registry.disable('pilot')

    assert.deepEqual(registry.activeToolNames(), ['other_tool'])
    assert.deepEqual(
      registry.activePromptBlocks().map((b) => b.id),
      ['o'],
    )
  })

  it('preserves pack storage across a disable (decision 17)', () => {
    const registry = new PackRegistry()
    registry.register(pilotPack())
    registry.storage('pilot').set('lastTodoId', 't-7')

    registry.disable('pilot')

    // Storage survives disable — like a disabled browser extension's data.
    assert.equal(registry.storage('pilot').get('lastTodoId'), 't-7')

    registry.enable('pilot')
    assert.equal(registry.storage('pilot').get('lastTodoId'), 't-7')
  })
})
