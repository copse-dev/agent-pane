// Contract test: history rendering never consults live pack registration
// (decision 17 of docs/plans/hooks-and-feature-packs.md).
//
// Disabling a pack removes its tools/hooks/prompt/UI from *new work* — but
// opening an old conversation must still render that pack's tool calls and hook
// cards exactly as they ran. This is proven mechanically: the shipped renderers
// (`hookCardFromSpineLine`, `getToolDisplayName`) take only spine data, never the
// registry, so toggling the registry's enablement cannot change historical
// output. This test crosses the real boundary — the `@copse/agent` pack registry
// on one side, the shipped `src/shared` renderers on the other.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PackRegistry } from '@copse/agent/packs/pack-registry.ts'
import { definePack, type RegisteredPack } from '@copse/agent/packs/pack-manifest.ts'
import type { BlockingHook } from '@copse/agent/hooks/canonical-events.ts'
import { hookCardFromSpineLine } from '@shared/hooks/hook-card.ts'
import { getToolDisplayName } from '@shared/tools/tool-display.ts'
import type { SpineHookRunLine } from '@shared/threads/spine-schema.ts'

const packHook: BlockingHook<'toolGate'> = {
  id: 'pack-hook',
  event: 'toolGate',
  run() {
    return undefined
  },
}

function packWithHistory(): RegisteredPack {
  return definePack(
    { name: 'history-pack', trust: 'first-party', storage: { namespace: 'history-pack' } },
    { toolNames: ['pack_tool'], blockingHooks: [packHook] },
  )
}

// A historical `hook_run` spine line authored by the pack's hook — the single
// source of truth a transcript renders from (decision 6 + G1).
const historicalHookRun: SpineHookRunLine = {
  v: 1,
  type: 'hook_run',
  id: 'run-1',
  event: 'toolGate',
  hookId: 'pack-hook',
  executor: 'function',
  startedAt: 1_000,
  durationMs: 5,
  parseOk: true,
  decision: { permission: 'allow' },
}

describe('history never consults live pack registration (decision 17)', () => {
  it('renders a disabled pack’s hook card + tool display identically to enabled', () => {
    const registry = new PackRegistry()
    registry.register(packWithHistory())

    // Registration for new work is present while enabled.
    assert.deepEqual(registry.activeToolNames(), ['pack_tool'])
    assert.deepEqual(
      registry.activeBlockingHooks().map((h) => h.id),
      ['pack-hook'],
    )

    // Historical rendering resolves from spine data + shipped code.
    const cardBefore = hookCardFromSpineLine(historicalHookRun)
    const toolDisplayBefore = getToolDisplayName('pack_tool')

    // Disable the pack: its contributions leave the active set for new work.
    registry.disable('history-pack')
    assert.equal(registry.isEnabled('history-pack'), false)
    assert.deepEqual(registry.activeToolNames(), [])
    assert.deepEqual(registry.activeBlockingHooks(), [])

    // History is unchanged — the renderers never saw the registry.
    const cardAfter = hookCardFromSpineLine(historicalHookRun)
    const toolDisplayAfter = getToolDisplayName('pack_tool')
    assert.deepEqual(cardAfter, cardBefore)
    assert.equal(toolDisplayAfter, toolDisplayBefore)

    // The card is a faithful function of the spine line, not of registration.
    assert.equal(cardAfter.hookId, 'pack-hook')
    assert.equal(cardAfter.event, 'toolGate')
    assert.equal(cardAfter.status, 'allow')
  })
})
