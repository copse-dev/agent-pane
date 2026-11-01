import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { CommandPhase } from '@copse/agent/wire-types.ts'
import { commandPhaseLabel, liveCommandPhase } from './command-phase-display.ts'

const phase = (patch: Partial<CommandPhase> & Pick<CommandPhase, 'state'>): CommandPhase => ({
  since: 1,
  launched: false,
  ...patch,
})

describe('commandPhaseLabel', () => {
  it('names every stage before the command exits', () => {
    assert.deepEqual(commandPhaseLabel(phase({ state: 'queued' })), { text: 'Queued' })
    assert.deepEqual(commandPhaseLabel(phase({ state: 'awaiting_approval' })), {
      text: 'Waiting for approval',
    })
    assert.deepEqual(commandPhaseLabel(phase({ state: 'starting' })), { text: 'Starting' })
    assert.deepEqual(commandPhaseLabel(phase({ state: 'running', launched: true })), {
      text: 'Running',
    })
  })

  it('names the background task a command became', () => {
    assert.deepEqual(
      commandPhaseLabel(phase({ state: 'running', launched: true, backgroundTaskId: 'bg-1' })),
      { text: 'Background task bg-1', detail: 'Its output is under Background tasks.' },
    )
  })

  it('leaves a clean exit to the card status and names any other ending', () => {
    assert.equal(commandPhaseLabel(phase({ state: 'exited', launched: true, exitCode: 0 })), null)
    assert.deepEqual(commandPhaseLabel(phase({ state: 'exited', launched: true, exitCode: 2 })), {
      text: 'Exit 2',
    })
    assert.deepEqual(commandPhaseLabel(phase({ state: 'timed_out', launched: true })), {
      text: 'Timed out',
    })
    assert.deepEqual(commandPhaseLabel(phase({ state: 'cancelled', launched: true })), {
      text: 'Stopped',
    })
  })

  it('keeps a command that never launched apart from one that ran', () => {
    assert.deepEqual(commandPhaseLabel(phase({ state: 'cancelled' })), {
      text: 'Cancelled before start',
    })
    assert.deepEqual(
      commandPhaseLabel(phase({ state: 'not_started', reason: 'Sandbox unavailable.' })),
      { text: 'Did not start', detail: 'Sandbox unavailable.' },
    )
    assert.deepEqual(commandPhaseLabel(phase({ state: 'not_started' })), { text: 'Did not start' })
  })

  it('shows nothing for a call without a phase', () => {
    assert.equal(commandPhaseLabel(undefined), null)
  })
})

describe('liveCommandPhase', () => {
  it('surfaces the newest command still in flight and ignores settled ones', () => {
    const waiting = phase({ state: 'awaiting_approval' })
    assert.equal(
      liveCommandPhase([
        { status: 'running', commandPhase: phase({ state: 'queued' }) },
        { status: 'running', commandPhase: waiting },
        { status: 'done', commandPhase: phase({ state: 'exited', exitCode: 0 }) },
        { status: 'running' },
      ]),
      waiting,
    )
    assert.equal(
      liveCommandPhase([{ status: 'error', commandPhase: phase({ state: 'timed_out' }) }]),
      undefined,
    )
  })
})
