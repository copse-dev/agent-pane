import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  backoffDelay,
  nextOrderAllowedAt,
  ORDER_WINDOW_MS,
  recentOrders,
  renewalTime,
} from './names-renewal.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR

describe('renewalTime', () => {
  const issued = { notBeforeMs: 0, notAfterMs: 6 * DAY }

  it('renews at two thirds of the lifetime without a renewal window', () => {
    assert.equal(renewalTime({ ...issued, renewalWindow: null }, HOUR), 4 * DAY)
  })

  it('picks a point inside the ARI window', () => {
    const certificate = { ...issued, renewalWindow: { startMs: 3 * DAY, endMs: 4 * DAY } }
    assert.equal(
      renewalTime(certificate, HOUR, () => 0),
      3 * DAY,
    )
    assert.equal(
      renewalTime(certificate, HOUR, () => 0.5),
      3.5 * DAY,
    )
    const late = renewalTime(certificate, HOUR, () => 0.999_999)
    assert.ok(late < 4 * DAY && late >= 3 * DAY)
  })

  it('never schedules in the past', () => {
    const now = 5 * DAY
    assert.equal(renewalTime({ ...issued, renewalWindow: null }, now), now)
    assert.equal(
      renewalTime({ ...issued, renewalWindow: { startMs: DAY, endMs: 2 * DAY } }, now),
      now,
    )
    const inside = renewalTime(
      { ...issued, renewalWindow: { startMs: 4 * DAY, endMs: 6 * DAY } },
      now,
      () => 0,
    )
    assert.equal(inside, now)
  })

  it('falls back to two thirds when the window is empty or inverted', () => {
    assert.equal(
      renewalTime({ ...issued, renewalWindow: { startMs: 3 * DAY, endMs: 3 * DAY } }, 0),
      4 * DAY,
    )
  })
})

describe('backoffDelay', () => {
  it('doubles from one minute and caps at six hours', () => {
    assert.equal(backoffDelay(1), 60_000)
    assert.equal(backoffDelay(2), 120_000)
    assert.equal(backoffDelay(5), 16 * 60_000)
    assert.equal(backoffDelay(50), 6 * HOUR)
  })

  it('waits at least as long as Retry-After', () => {
    assert.equal(backoffDelay(1, 3600), HOUR)
    assert.equal(backoffDelay(10, 1), 6 * HOUR)
  })
})

describe('order limit', () => {
  it('allows six orders in a rolling day', () => {
    const now = 10 * DAY
    const five = [1, 2, 3, 4, 5].map((n) => now - n * HOUR)
    assert.equal(nextOrderAllowedAt(five, now), now)
    const six = [...five, now - 20 * HOUR]
    assert.equal(nextOrderAllowedAt(six, now), now - 20 * HOUR + ORDER_WINDOW_MS)
  })

  it('forgets orders older than a day', () => {
    const now = 10 * DAY
    const orders = [now - 2 * DAY, now - DAY - 1, now - HOUR]
    assert.deepEqual(recentOrders(orders, now), [now - HOUR])
    assert.equal(nextOrderAllowedAt([...orders, ...orders, ...orders], now), now)
  })
})
