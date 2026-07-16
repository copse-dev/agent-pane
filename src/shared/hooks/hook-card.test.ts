import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getHookCardStatusLabel,
  getHookCardTitle,
  hookCardFromSpineLine,
  hookEventLabel,
  isHookCardBlocking,
} from './hook-card.ts'
import { SPINE_SCHEMA_VERSION, type SpineHookRunLine } from '../threads/spine-schema.ts'

function line(overrides: Partial<SpineHookRunLine> = {}): SpineHookRunLine {
  return {
    v: SPINE_SCHEMA_VERSION,
    type: 'hook_run',
    id: 'run-1',
    event: 'beforeShellExecution',
    hookId: 'guard.sh',
    executor: 'command',
    startedAt: 0,
    durationMs: 12,
    exitCode: 0,
    parseOk: true,
    decision: {},
    ...overrides,
  }
}

// Contract for decision 10's card model: the always-on spine `hook_run` record
// (decision 6) is the single source of truth, and the display card is a pure
// derivation of it — so history rendering never depends on live registration.
describe('hookCardFromSpineLine (decision 10)', () => {
  it('maps a plain observation execution to an "ok" execution card', () => {
    const card = hookCardFromSpineLine(line())
    assert.equal(card.kind, 'execution')
    assert.equal(card.status, 'ok')
    assert.equal(card.event, 'beforeShellExecution')
    assert.equal(card.hookId, 'guard.sh')
    assert.equal(card.executor, 'command')
    assert.equal(card.exitCode, 0)
  })

  it('maps an allow verdict to an allow execution card', () => {
    const card = hookCardFromSpineLine(line({ decision: { permission: 'allow' } }))
    assert.equal(card.kind, 'execution')
    assert.equal(card.status, 'allow')
  })

  it('maps deny / ask permission verdicts to decision cards', () => {
    assert.equal(hookCardFromSpineLine(line({ decision: { permission: 'deny' } })).kind, 'decision')
    assert.equal(hookCardFromSpineLine(line({ decision: { permission: 'deny' } })).status, 'deny')
    assert.equal(hookCardFromSpineLine(line({ decision: { permission: 'ask' } })).status, 'ask')
  })

  it('maps an applied halt and a stale-suppressed halt distinctly (decisions 12 & 16)', () => {
    const applied = hookCardFromSpineLine(
      line({ event: 'stop', decision: { haltRun: true, haltApplied: true, stopReason: 'budget' } }),
    )
    assert.equal(applied.kind, 'halt')
    assert.equal(applied.status, 'halted')
    assert.equal(applied.stopReason, 'budget')

    const suppressed = hookCardFromSpineLine(
      line({ event: 'stop', decision: { haltRun: true, haltSuppressedStale: true } }),
    )
    assert.equal(suppressed.kind, 'halt')
    assert.equal(suppressed.status, 'halt-suppressed')
  })

  it('surfaces a sandbox block regardless of the printed verdict (F3, decision 7)', () => {
    // A hook that printed `allow` but was killed by seatbelt must never render as
    // allowed — the block wins.
    const card = hookCardFromSpineLine(
      line({ decision: { permission: 'allow', sandboxBlocked: true } }),
    )
    assert.equal(card.status, 'blocked')
    assert.equal(card.sandboxBlocked, true)
    assert.ok(isHookCardBlocking(card.status))
  })

  it('surfaces a function-hook throw as an error card (decision 9)', () => {
    const card = hookCardFromSpineLine(line({ executor: 'function', error: 'boom' }))
    assert.equal(card.status, 'error')
    assert.equal(card.error, 'boom')
    assert.ok(isHookCardBlocking(card.status))
  })

  it('carries the H1/H2 signal counts through for the detail line', () => {
    const card = hookCardFromSpineLine(
      line({ decision: { updatedInput: true, injectContextChars: 40, queuedMessageChars: 8 } }),
    )
    assert.equal(card.updatedInput, true)
    assert.equal(card.injectContextChars, 40)
    assert.equal(card.queuedMessageChars, 8)
  })
})

describe('hook card labels', () => {
  it('humanizes camelCase / snake event names', () => {
    assert.equal(hookEventLabel('beforeShellExecution'), 'Before shell execution')
    assert.equal(hookEventLabel('afterToolUse'), 'After tool use')
    assert.equal(hookEventLabel('stop'), 'Stop')
    assert.equal(hookEventLabel('session_start'), 'Session start')
  })

  it('titles from the event and badges the status', () => {
    const card = hookCardFromSpineLine(line({ event: 'stop', decision: { permission: 'deny' } }))
    assert.equal(getHookCardTitle(card), 'Stop')
    assert.equal(getHookCardStatusLabel(card), 'Denied')
  })
})
