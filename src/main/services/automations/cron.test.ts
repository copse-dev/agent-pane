import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cronMatches, validateCronExpression } from './cron.ts'

describe('automation cron expressions', () => {
  it('matches lists, ranges, and steps in local time', () => {
    const mondayAtNineThirty = new Date(2026, 6, 27, 9, 30, 0)
    assert.equal(cronMatches('*/15 9-17 * * 1-5', mondayAtNineThirty), true)
    assert.equal(cronMatches('0 9-17 * * 1-5', mondayAtNineThirty), false)
  })

  it('accepts Sunday as both 0 and 7', () => {
    const sunday = new Date(2026, 6, 26, 8, 0, 0)
    assert.equal(cronMatches('0 8 * * 0', sunday), true)
    assert.equal(cronMatches('0 8 * * 7', sunday), true)
  })

  it('uses standard OR semantics when both day fields are restricted', () => {
    // Monday the 27th matches weekday even though it is not day 1.
    const monday = new Date(2026, 6, 27, 8, 0, 0)
    assert.equal(cronMatches('0 8 1 * 1', monday), true)
  })

  it('rejects malformed and out-of-range expressions', () => {
    assert.throws(() => {
      validateCronExpression('0 9 * *')
    }, /five cron fields/)
    assert.throws(() => {
      validateCronExpression('60 9 * * *')
    }, /between 0 and 59/)
    assert.throws(() => {
      validateCronExpression('*/0 9 * * *')
    }, /between 1 and 59/)
  })
})
