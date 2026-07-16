// Contract test pinning the full canonical event catalogue (A1) against the
// "Canonical events (v1 enumeration)" table in
// docs/plans/hooks-and-feature-packs.md. The event names are final — changing
// one is a decisions-log edit, not a refactor — so this test is the mechanical
// guard that the name union, the spec table, and the plan's Kind column stay in
// lockstep.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  HOOK_EVENT_NAMES,
  HOOK_EVENT_SPECS,
  type HookDispatch,
  type HookEventName,
  type HookRole,
} from './canonical-events.ts'

/** The plan's table, transcribed. `asyncOptIn` mirrors "blocking or async". */
const EXPECTED: Record<
  HookEventName,
  { dispatch: HookDispatch; role: HookRole; asyncOptIn?: boolean }
> = {
  turnStart: { dispatch: 'blocking', role: 'assembly' },
  beforeFinalize: { dispatch: 'blocking', role: 'assembly' },
  beforeSubmitPrompt: { dispatch: 'blocking', role: 'decision' },
  toolGate: { dispatch: 'blocking', role: 'decision' },
  afterFileEdit: { dispatch: 'blocking', role: 'decision', asyncOptIn: true },
  stop: { dispatch: 'async', role: 'observation' },
  afterToolUse: { dispatch: 'async', role: 'observation' },
  subagentStart: { dispatch: 'blocking', role: 'decision' },
  subagentStop: { dispatch: 'async', role: 'observation' },
  sessionStart: { dispatch: 'async', role: 'observation' },
  compaction: { dispatch: 'async', role: 'observation' },
  permissionDecision: { dispatch: 'async', role: 'observation' },
  beforeDiffApply: { dispatch: 'blocking', role: 'decision' },
  afterDiffApply: { dispatch: 'async', role: 'observation' },
}

describe('canonical event catalogue (A1 v1 enumeration)', () => {
  it('enumerates exactly the 14 canonical events from the plan', () => {
    assert.deepEqual([...HOOK_EVENT_NAMES], Object.keys(EXPECTED))
    assert.equal(HOOK_EVENT_NAMES.length, 14)
  })

  it('has no duplicate event names', () => {
    assert.equal(new Set(HOOK_EVENT_NAMES).size, HOOK_EVENT_NAMES.length)
  })

  it('every event has a spec whose name matches its key', () => {
    for (const name of HOOK_EVENT_NAMES) {
      assert.equal(HOOK_EVENT_SPECS[name].name, name)
    }
  })

  it('dispatch, role, and asyncOptIn match the plan Kind column', () => {
    for (const name of HOOK_EVENT_NAMES) {
      const spec = HOOK_EVENT_SPECS[name]
      const expected = EXPECTED[name]
      assert.equal(spec.dispatch, expected.dispatch, `${name} dispatch`)
      assert.equal(spec.role, expected.role, `${name} role`)
      assert.equal(spec.asyncOptIn, expected.asyncOptIn, `${name} asyncOptIn`)
    }
  })

  it('only afterFileEdit is dual-dispatch (blocking-default, async opt-in)', () => {
    const dual = HOOK_EVENT_NAMES.filter((n) => HOOK_EVENT_SPECS[n].asyncOptIn)
    assert.deepEqual(dual, ['afterFileEdit'])
  })
})
