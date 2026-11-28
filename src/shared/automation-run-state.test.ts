import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Thread } from '@shared/types'
import { automationRunBlock, hasThreadRun } from './automation-run-state.ts'

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

const priorRunEvidence: Array<{ name: string; metadata: Partial<Thread> }> = [
  { name: 'a submitted prompt', metadata: { lastPromptAt: 0 } },
  { name: 'recorded usage', metadata: { usage: { inputTokens: 1, outputTokens: 0 } } },
  { name: 'a working brief', metadata: { workingBrief: 'Check the release.' } },
  { name: 'an auto-title pass', metadata: { autoTitleCount: 0 } },
]

for (const { name, metadata } of priorRunEvidence) {
  test(`a human follow-up after ${name} does not block a later automation`, () => {
    const completed: Pick<Thread, 'status'> & Partial<Thread> = {
      status: 'idle',
      draftPrompt: 'Keep this manual.',
      automation,
      ...metadata,
    }
    assert.equal(automationRunBlock(completed), null)
    assert.equal(automationRunBlock({ ...completed, status: 'running' }), 'running')
  })
}

test('zero usage does not turn a fresh scheduled draft into a completed run', () => {
  const pending: Pick<Thread, 'status'> & Partial<Thread> = {
    status: 'idle',
    draftPrompt: 'Start the scheduled check.',
    automation,
    usage: { inputTokens: 0, outputTokens: 0 },
  }
  assert.equal(automationRunBlock(pending), 'pending-start')
})

test('prior-run evidence uses metadata without requiring a transcript or new stored flag', () => {
  assert.equal(hasThreadRun({}), false)
  assert.equal(hasThreadRun({ lastPromptAt: 0 }), true)
  assert.equal(hasThreadRun({ workingBrief: '' }), true)
  assert.equal(hasThreadRun({ autoTitleCount: 0 }), true)
  assert.equal(hasThreadRun({ usage: { inputTokens: 0, outputTokens: 0 } }), false)
})

test('a failed or interrupted completed turn does not turn its follow-up into a first start', () => {
  const completed: Partial<Thread> & Pick<Thread, 'status'> = {
    status: 'error',
    lastPromptAt: 1,
    draftPrompt: 'Keep this manual.',
    automation,
  }
  assert.equal(automationRunBlock(completed), null)
  const interrupted: Partial<Thread> & Pick<Thread, 'status'> = {
    ...completed,
    status: 'idle',
    interruptedTurnAt: 2,
  }
  assert.equal(automationRunBlock(interrupted), null)
})
