import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NeedsInputBadge } from './needs-input-badge.ts'

function badge(enabled = true): {
  badge: NeedsInputBadge
  shown: number[]
  enable(on: boolean): void
} {
  const shown: number[] = []
  let on = enabled
  return {
    shown,
    badge: new NeedsInputBadge(
      (count) => shown.push(count),
      () => on,
    ),
    enable: (next): void => {
      on = next
    },
  }
}

describe('NeedsInputBadge', () => {
  it('counts distinct waiting threads and clears to 0 as prompts are answered', () => {
    const fake = badge()
    const approvalA = fake.badge.hold('thread-a')
    const questionA = fake.badge.hold('thread-a')
    const approvalB = fake.badge.hold('thread-b')

    assert.equal(fake.badge.pendingThreadCount(), 2)
    assert.deepEqual(fake.shown, [1, 2], 'a second prompt on thread-a does not add a thread')

    approvalA()
    assert.deepEqual(fake.shown, [1, 2], 'thread-a still has its question open')
    questionA()
    approvalB()
    assert.deepEqual(fake.shown, [1, 2, 1, 0])
  })

  it('counts each prompt with no thread on its own', () => {
    const fake = badge()
    const first = fake.badge.hold(undefined)
    fake.badge.hold(undefined)
    assert.deepEqual(fake.shown, [1, 2])
    first()
    assert.deepEqual(fake.shown, [1, 2, 1])
  })

  it('treats a repeated release as a no-op', () => {
    const fake = badge()
    const release = fake.badge.hold('thread-a')
    const other = fake.badge.hold('thread-b')
    release()
    release()
    assert.deepEqual(fake.shown, [1, 2, 1])
    other()
    assert.deepEqual(fake.shown, [1, 2, 1, 0])
  })

  it('shows nothing while needs-input alerts are off and follows the preference on refresh', () => {
    const fake = badge(false)
    const release = fake.badge.hold('thread-a')
    assert.deepEqual(fake.shown, [], 'the badge stays clear with the preference off')

    fake.enable(true)
    fake.badge.refresh()
    assert.deepEqual(fake.shown, [1], 'turning the preference on shows the prompt already open')

    fake.enable(false)
    fake.badge.refresh()
    assert.deepEqual(fake.shown, [1, 0])

    release()
    assert.deepEqual(fake.shown, [1, 0])
  })
})
