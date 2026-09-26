import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatSystemReminder } from '@copse/agent/hooks/inject-context.ts'
import { splitTrailingSystemReminders } from './tool-result-reminders.ts'

describe('splitTrailingSystemReminders', () => {
  it('splits a clamp note off the tool output', () => {
    const note = 'Arguments were clamped to schema bounds: max_results — clamped to 200.'
    assert.deepEqual(splitTrailingSystemReminders(`found\n\n${formatSystemReminder(note)}`), {
      output: 'found',
      reminders: [note],
    })
  })

  it('keeps several trailing blocks in the order they were appended', () => {
    const result = `found\n\n${formatSystemReminder('clamp note')}\n\n${formatSystemReminder(
      'hook line 1\nhook line 2',
    )}`
    assert.deepEqual(splitTrailingSystemReminders(result), {
      output: 'found',
      reminders: ['clamp note', 'hook line 1\nhook line 2'],
    })
  })

  it('leaves a result without a trailing block untouched', () => {
    const quoted = `${formatSystemReminder('quoted')}\nthen more output\n`
    assert.deepEqual(splitTrailingSystemReminders(quoted), { output: quoted, reminders: [] })
    assert.deepEqual(splitTrailingSystemReminders('plain\n'), { output: 'plain\n', reminders: [] })
  })

  it('returns empty output when the result is only a note', () => {
    assert.deepEqual(splitTrailingSystemReminders(formatSystemReminder('note')), {
      output: '',
      reminders: ['note'],
    })
  })
})
