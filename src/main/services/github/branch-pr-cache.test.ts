import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BranchPrCache, branchPrCache, type BranchPrResult } from './branch-pr-cache.ts'
import { invalidateGitHubReadCache } from './backend/github-read-cache.ts'

const pr = { number: 12, title: 'Feature', url: 'https://github.com/o/r/pull/12' }

describe('branch PR cache', () => {
  for (const value of [pr, null]) {
    it(`shares in-flight and settled ${value ? 'PR' : 'no PR'} results until expiry`, async () => {
      let now = 0
      const cache = new BranchPrCache(() => now)
      let calls = 0
      let finish: (result: BranchPrResult) => void = () => assert.fail('not started')
      const load = (): Promise<BranchPrResult> => {
        calls++
        return new Promise((resolve) => {
          finish = resolve
        })
      }
      const first = cache.get('branch', load)
      const second = cache.get('branch', load)
      assert.equal(calls, 1)
      now = 20_000
      finish({ ok: true, pr: value })
      assert.deepEqual(await Promise.all([first, second]), [value, value])
      now = 79_999
      assert.deepEqual(await cache.get('branch', load), value)
      assert.equal(calls, 1, 'TTL begins when the remote read finishes')
      now = 80_000
      const expired = cache.get('branch', load)
      assert.equal(calls, 2)
      finish({ ok: true, pr: value })
      await expired
    })
  }

  it('backs off rejected and unsuccessful reads for five minutes', async () => {
    for (const rejects of [false, true]) {
      let now = 0
      let calls = 0
      const cache = new BranchPrCache(() => now)
      const load = async (): Promise<BranchPrResult> => {
        calls++
        if (rejects) throw new Error('offline')
        return { ok: false, pr: null }
      }
      assert.equal(await cache.get('branch', load), null)
      now = 299_999
      for (let i = 0; i < 20; i++) await cache.get('branch', load)
      assert.equal(calls, 1)
      now = 300_000
      await cache.get('branch', load)
      assert.equal(calls, 2)
      cache.invalidate('branch')
      await cache.get('branch', load)
      assert.equal(calls, 3, 'explicit invalidation bypasses failure backoff')
    }
  })

  it('prevents an invalidated in-flight read from restoring stale data', async () => {
    const cache = new BranchPrCache()
    let finish: (result: BranchPrResult) => void = () => assert.fail('not started')
    const old = cache.get(
      'branch',
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    cache.invalidate('branch')
    assert.equal(await cache.get('branch', async () => ({ ok: true, pr: null })), null)
    finish({ ok: true, pr })
    await old
    assert.equal(await cache.get('branch', async () => assert.fail('unexpected read')), null)
  })

  it('manual GitHub refresh invalidates shared branch observations', async () => {
    branchPrCache.invalidate()
    await branchPrCache.get('branch', async () => ({ ok: true, pr: null }))
    invalidateGitHubReadCache()
    assert.deepEqual(await branchPrCache.get('branch', async () => ({ ok: true, pr })), pr)
    branchPrCache.invalidate()
  })
})
