import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  addActiveRecording,
  formatRecordingClock,
  subscribeActiveRecordings,
  type ActiveRecording,
} from './active-recordings.ts'

function recording(id: string): ActiveRecording {
  return { id, label: `Desktop — ${id}`, startedAt: 0, stop: (): void => {} }
}

describe('active recordings', () => {
  it('tells a subscriber about the current set immediately and on every change', () => {
    const seen: string[][] = []
    const unsubscribe = subscribeActiveRecordings((list) => seen.push(list.map((r) => r.id)))
    const removeA = addActiveRecording(recording('a'))
    const removeB = addActiveRecording(recording('b'))
    removeA()
    removeB()
    unsubscribe()
    assert.deepEqual(seen, [[], ['a'], ['a', 'b'], ['b'], []])
  })

  it('ignores a stale remover once the id has been re-registered', () => {
    const removeOld = addActiveRecording(recording('same'))
    removeOld()
    const replacement = recording('same')
    const removeNew = addActiveRecording(replacement)
    removeOld()
    let current: readonly ActiveRecording[] = []
    const unsubscribe = subscribeActiveRecordings((list) => {
      current = list
    })
    assert.deepEqual(current, [replacement])
    removeNew()
    unsubscribe()
  })
})

describe('formatRecordingClock', () => {
  it('formats elapsed time as m:ss', () => {
    assert.equal(formatRecordingClock(0), '0:00')
    assert.equal(formatRecordingClock(9_999), '0:09')
    assert.equal(formatRecordingClock(65_000), '1:05')
    assert.equal(formatRecordingClock(300_000), '5:00')
    assert.equal(formatRecordingClock(-50), '0:00')
  })
})
