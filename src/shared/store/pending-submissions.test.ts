import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from './store.ts'
import {
  beginThreadSubmission,
  endThreadSubmission,
  isThreadSubmitting,
} from './pending-submissions.ts'

describe('submission ownership', () => {
  it('notifies on actual ownership changes and rejects duplicates', () => {
    const store = createStore()
    const changes: (readonly string[])[] = []
    store.select(
      (state) => state.pendingSubmissionThreadIds,
      (next) => changes.push(next),
    )
    assert.equal(beginThreadSubmission(store, 'one'), true)
    assert.equal(beginThreadSubmission(store, 'one'), false)
    assert.equal(beginThreadSubmission(store, 'two'), true)
    endThreadSubmission(store, 'missing')
    endThreadSubmission(store, 'one')
    assert.equal(isThreadSubmitting(store, 'one'), false)
    assert.equal(isThreadSubmitting(store, 'two'), true)
    endThreadSubmission(store, 'two')
    endThreadSubmission(store, 'two')
    assert.deepEqual(changes, [['one'], ['one', 'two'], ['two'], []])
  })

  it('retains ownership through navigation and isolates store sessions', () => {
    const store = createStore({ activeProjectId: 'p', activeThreadId: 'one' })
    assert.equal(beginThreadSubmission(store, 'one'), true)
    store.setState({ activeProjectId: 'other', activeThreadId: 'two' })
    assert.equal(isThreadSubmitting(store, 'one'), true)
    assert.equal(isThreadSubmitting(createStore(), 'one'), false)
    endThreadSubmission(store, 'one')
    assert.equal(isThreadSubmitting(store, 'one'), false)
  })
})
