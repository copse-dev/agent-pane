// Contract tests for halt-run semantics (H3), named for the decisions they pin
// (execution-guidance rule 2), in the house style of permission-platform.test.ts:
//
//   - decision 12 — `haltRun` routes through the run's abort path, attributed to
//                   the hook; allowed from async hooks.
//   - decision 16 — a stale-epoch `haltRun` is a *suppressed no-op*, recorded in
//                   the spine as suppressed; only a halt whose epoch matches the
//                   currently-active run may abort.
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AsyncOutcomeRecord } from '@copse/agent/hooks/hook-registry.ts'
import { asTurnTreeId, type TurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import {
  registerHaltTarget,
  clearHaltTarget,
  requestAsyncHaltRun,
  haltRunFromBlockingHook,
  setHaltRunRecorderForTesting,
  type HaltDisposition,
} from './halt-run.ts'
import { hookQueueOutcomeSink } from './hook-queue-channel.ts'
import type { HookRunRecordingSnapshot } from '../hook-run-recorder.ts'

const CURRENT: TurnTreeId = asTurnTreeId('turn-tree-current')
const STALE: TurnTreeId = asTurnTreeId('turn-tree-stale')
const THREAD = 'thread-1'

interface RecordedHalt {
  event: string
  hookId: string
  executor: 'function' | 'command'
  applied: boolean
  reason: string
}

/** Install a recorder spy + a fresh registry per test, restored afterward. */
function harness(): {
  recorded: RecordedHalt[]
  aborts: string[]
  registerCurrent: () => void
} {
  const recorded: RecordedHalt[] = []
  const aborts: string[] = []
  setHaltRunRecorderForTesting((input) => recorded.push(input))
  return {
    recorded,
    aborts,
    registerCurrent: (): void => {
      registerHaltTarget(THREAD, CURRENT, (reason) => {
        aborts.push(reason)
      })
    },
  }
}

function asyncRecord(turnTreeId: TurnTreeId, halt?: { reason: string }): AsyncOutcomeRecord {
  return {
    event: 'afterToolUse',
    hookId: 'guard-hook',
    turnTreeId,
    outcome: halt ? { haltRun: halt } : {},
  }
}

afterEach(() => {
  setHaltRunRecorderForTesting(null)
  clearHaltTarget(THREAD, CURRENT)
  clearHaltTarget(THREAD, STALE)
})

describe('async haltRun routes through the abort path (decision 12)', () => {
  it('aborts the current turn when the emitting epoch is current', () => {
    const { recorded, aborts, registerCurrent } = harness()
    registerCurrent()

    const disposition: HaltDisposition = requestAsyncHaltRun(
      asyncRecord(CURRENT, { reason: 'secret detected — stop' }),
      THREAD,
    )

    assert.equal(disposition, 'halted')
    assert.deepEqual(aborts, ['secret detected — stop'])
    // Spine records the applied halt, attributed to the hook.
    assert.equal(recorded.length, 1)
    assert.deepEqual(recorded[0], {
      event: 'afterToolUse',
      hookId: 'guard-hook',
      executor: 'function',
      applied: true,
      reason: 'secret detected — stop',
    })
  })
})

describe('stale-epoch haltRun is a suppressed no-op (decision 16)', () => {
  it('never aborts when the emitting epoch is not the current turn tree', () => {
    const { recorded, aborts, registerCurrent } = harness()
    registerCurrent() // a *newer*, unrelated human turn is active

    const disposition = requestAsyncHaltRun(
      asyncRecord(STALE, { reason: 'late stop from a finished turn' }),
      THREAD,
    )

    assert.equal(disposition, 'suppressed-stale')
    assert.deepEqual(aborts, []) // the newer turn is never aborted
    // Still recorded — as suppressed, not applied — so it is not silent.
    assert.equal(recorded.length, 1)
    const entry = recorded[0]
    assert.ok(entry)
    assert.equal(entry.applied, false)
    assert.equal(entry.reason, 'late stop from a finished turn')
  })

  it('never aborts when no run is active on the thread', () => {
    const { recorded, aborts } = harness()

    const disposition = requestAsyncHaltRun(asyncRecord(CURRENT, { reason: 'stop' }), THREAD)

    assert.equal(disposition, 'suppressed-stale')
    assert.deepEqual(aborts, [])
    assert.equal(recorded[0]?.applied, false)
  })

  it('does nothing for an outcome that carries no haltRun', () => {
    const { recorded, aborts, registerCurrent } = harness()
    registerCurrent()

    const disposition = requestAsyncHaltRun(asyncRecord(CURRENT), THREAD)

    assert.equal(disposition, 'suppressed-stale')
    assert.deepEqual(aborts, [])
    assert.equal(recorded.length, 0)
  })
})

describe('blocking haltRun aborts a run in flight (decision 12, consistent semantics)', () => {
  it('aborts the active run — a blocking hook is current by construction', () => {
    const { recorded, aborts, registerCurrent } = harness()
    registerCurrent()

    const disposition = haltRunFromBlockingHook({
      threadId: THREAD,
      event: 'toolGate',
      hookId: 'block-danger.sh',
      reason: 'dangerous command',
    })

    assert.equal(disposition, 'halted')
    assert.deepEqual(aborts, ['dangerous command'])
    assert.deepEqual(recorded[0], {
      event: 'toolGate',
      hookId: 'block-danger.sh',
      executor: 'command',
      applied: true,
      reason: 'dangerous command',
    })
  })

  it('is a no-op when no run is active (nothing to abort)', () => {
    const { recorded, aborts } = harness()

    const disposition = haltRunFromBlockingHook({
      threadId: THREAD,
      event: 'toolGate',
      hookId: 'block-danger.sh',
      reason: 'dangerous command',
    })

    assert.equal(disposition, 'suppressed-stale')
    assert.deepEqual(aborts, [])
    assert.equal(recorded[0]?.applied, false)
  })
})

describe('the async outcome sink routes haltRun to the abort path (H3 wiring)', () => {
  it('hookQueueOutcomeSink aborts on a current-epoch async haltRun', () => {
    const { aborts, registerCurrent } = harness()
    registerCurrent()

    const sink = hookQueueOutcomeSink(THREAD)
    sink(asyncRecord(CURRENT, { reason: 'stop via sink' }))

    assert.deepEqual(aborts, ['stop via sink'])
  })

  it('hookQueueOutcomeSink suppresses a stale-epoch async haltRun', () => {
    const { aborts, registerCurrent } = harness()
    registerCurrent()

    const sink = hookQueueOutcomeSink(THREAD)
    sink(asyncRecord(STALE, { reason: 'late stop via sink' }))

    assert.deepEqual(aborts, [])
  })
})

describe('stale halts record against the fire-site snapshot (decisions 3/6/16)', () => {
  it('forwards the emitting fire site snapshot to the recorder for a stale async halt', () => {
    // The canonical stale case: the emitting turn's recording window has closed
    // (endHookRunRecording ran), so the suppressed effect line must record
    // against the snapshot captured at the fire site — recording against the
    // live context would drop it or attribute it to a newer turn.
    const snapshots: unknown[] = []
    setHaltRunRecorderForTesting((input, snapshot) => {
      snapshots.push(snapshot)
      void input
    })
    const fireSiteSnapshot: HookRunRecordingSnapshot = {
      projectId: 'p',
      threadId: THREAD,
      turnId: 'turn-old',
      step: 0,
      toolset: null,
    }

    const sink = hookQueueOutcomeSink(THREAD, fireSiteSnapshot)
    sink(asyncRecord(STALE, { reason: 'late stop' }))

    assert.equal(snapshots.length, 1, 'suppressed halt still records')
    assert.equal(snapshots[0], fireSiteSnapshot, 'recorded against the fire-site snapshot')
  })

  it('leaves the snapshot undefined for blocking halts (live context by construction)', () => {
    const snapshots: unknown[] = []
    setHaltRunRecorderForTesting((input, snapshot) => {
      snapshots.push(snapshot)
      void input
    })

    haltRunFromBlockingHook({
      threadId: THREAD,
      event: 'toolGate',
      hookId: 'block.sh',
      reason: 'blocked',
    })

    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0], undefined, 'blocking path defaults to the live context')
  })
})
