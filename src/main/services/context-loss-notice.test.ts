import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { contextLossNotice, contextWasLost } from './context-loss-notice.ts'

describe('contextWasLost', () => {
  it('holds when the transcript has history the model does not', () => {
    assert.equal(contextWasLost(0, 5), true)
  })

  it('does not fire on a fresh thread whose first prompt is its only message', () => {
    assert.equal(contextWasLost(0, 1), false)
  })

  it('does not fire on a brand-new thread with nothing on screen yet', () => {
    assert.equal(contextWasLost(0, 0), false)
  })

  it('does not fire when the model has history of its own', () => {
    assert.equal(contextWasLost(4, 5), false)
  })
})

describe('contextLossNotice', () => {
  it('names the symptom and the count the user can check against', () => {
    const notice = contextLossNotice(3)

    assert.match(notice, /Earlier context is missing from this turn/)
    assert.match(notice, /transcript above has 3 messages/)
    assert.match(notice, /could not be rebuilt from them/)
    assert.match(notice, /ended before it could save/)
  })
})
