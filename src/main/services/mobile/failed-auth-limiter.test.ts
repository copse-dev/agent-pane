import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { FailedAuthLimiter } from './failed-auth-limiter.ts'

function fail(limiter: FailedAuthLimiter, peer: string, times: number): void {
  for (let attempt = 0; attempt < times; attempt++) limiter.failed(peer)
}

describe('failed device-token attempts', () => {
  it('blocks a peer after 30 failures in a row, for five minutes', () => {
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    try {
      const limiter = new FailedAuthLimiter()
      fail(limiter, 'relay 203.0.113.7', 29)
      assert.equal(limiter.blocked('relay 203.0.113.7'), false)
      limiter.failed('relay 203.0.113.7')
      assert.equal(limiter.blocked('relay 203.0.113.7'), true)
      assert.equal(limiter.blocked('relay 203.0.113.8'), false, 'other peers are unaffected')
      mock.timers.tick(299_999)
      assert.equal(limiter.blocked('relay 203.0.113.7'), true)
      mock.timers.tick(2)
      assert.equal(limiter.blocked('relay 203.0.113.7'), false)
      // After the block, counting starts again.
      limiter.failed('relay 203.0.113.7')
      assert.equal(limiter.blocked('relay 203.0.113.7'), false)
    } finally {
      mock.timers.reset()
    }
  })

  it('forgets a peer once it presents a valid token', () => {
    const limiter = new FailedAuthLimiter()
    fail(limiter, '192.168.1.20', 29)
    limiter.succeeded('192.168.1.20')
    fail(limiter, '192.168.1.20', 29)
    assert.equal(limiter.blocked('192.168.1.20'), false)
    limiter.failed('192.168.1.20')
    assert.equal(limiter.blocked('192.168.1.20'), true)
  })

  it('remembers at most 1,024 peers, forgetting the earliest first', () => {
    const limiter = new FailedAuthLimiter()
    fail(limiter, 'relay earliest', 29)
    // 1,023 more fills the map; one more forgets the earliest peer and its 29 failures.
    for (let index = 0; index < 1024; index++) limiter.failed(`relay 198.51.100.${String(index)}`)
    limiter.failed('relay earliest')
    assert.equal(limiter.blocked('relay earliest'), false)
    // A peer still remembered keeps its count: 29 more failures block it.
    fail(limiter, 'relay 198.51.100.1023', 29)
    assert.equal(limiter.blocked('relay 198.51.100.1023'), true)
  })
})
