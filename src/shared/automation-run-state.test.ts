import assert from 'node:assert/strict'
import { test } from 'node:test'
import { automationRunBlock } from './automation-run-state.ts'

const automation = { scheduleId: 's', scheduleName: 'n', triggeredAt: 1 }

test('a running turn blocks the next trigger', () => {
  assert.equal(automationRunBlock({ status: 'running', automation }), 'running')
})

test('an unsent draft blocks the next trigger until its start fails', () => {
  assert.equal(
    automationRunBlock({ status: 'idle', draftPrompt: 'Go.', automation }),
    'pending-start',
  )
  assert.equal(
    automationRunBlock({
      status: 'idle',
      draftPrompt: 'Go.',
      automation: { ...automation, startFailedAt: 2 },
    }),
    null,
  )
})

test('a finished run, or a blank draft, blocks nothing', () => {
  assert.equal(automationRunBlock({ status: 'idle', automation }), null)
  assert.equal(automationRunBlock({ status: 'error', draftPrompt: '  ', automation }), null)
})
