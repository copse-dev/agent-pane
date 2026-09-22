import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AsyncTtlCache } from './async-ttl-cache.ts'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('AsyncTtlCache', () => {
  it('reuses a settled value until its TTL expires', async () => {
    let now = 100
    let loads = 0
    const cache = new AsyncTtlCache<string, number>({
      ttlMs: 50,
      now: (): number => now,
    })
    const load = (): Promise<number> => Promise.resolve(++loads)

    assert.equal(await cache.get('a', load), 1)
    now = 149
    assert.equal(await cache.get('a', load), 1)
    now = 150
    assert.equal(await cache.get('a', load), 2)
  })

  it('starts the TTL when a slow load resolves', async () => {
    let now = 0
    const gate = deferred<string>()
    const cache = new AsyncTtlCache<string, string>({
      ttlMs: 10,
      now: (): number => now,
    })
    const first = cache.get('a', () => gate.promise)
    now = 100
    gate.resolve('value')
    await first

    now = 109
    assert.deepEqual(cache.peek('a'), { hit: true, value: 'value' })
    now = 110
    assert.deepEqual(cache.peek('a'), { hit: false })
  })

  it('observes a clock replacement made after construction', () => {
    const cache = new AsyncTtlCache<string, string>({ ttlMs: 10 })
    const originalNow = Date.now
    let now = 100
    Date.now = (): number => now
    try {
      cache.set('a', 'value')
      now = 110
      assert.deepEqual(cache.peek('a'), { hit: false })
    } finally {
      Date.now = originalNow
    }
  })

  it('coalesces overlapping loads per key while keeping keys independent', async () => {
    const a = deferred<string>()
    const b = deferred<string>()
    const cache = new AsyncTtlCache<string, string>({ ttlMs: 100 })
    let loads = 0

    const firstA = cache.get('a', () => {
      loads++
      return a.promise
    })
    const secondA = cache.get('a', () => {
      loads++
      return Promise.resolve('wrong')
    })
    const firstB = cache.get('b', () => {
      loads++
      return b.promise
    })
    assert.equal(loads, 2)

    a.resolve('A')
    b.resolve('B')
    assert.deepEqual(await Promise.all([firstA, secondA, firstB]), ['A', 'A', 'B'])
  })

  it('does not cache rejections and releases joined callers', async () => {
    const gate = deferred<string>()
    const cache = new AsyncTtlCache<string, string>({ ttlMs: 100 })
    let loads = 0
    const failing = (): Promise<string> => {
      loads++
      return gate.promise.then(() => Promise.reject(new Error('boom')))
    }
    const first = cache.get('a', failing)
    const second = cache.get('a', failing)
    gate.resolve('go')

    await assert.rejects(first, /boom/)
    await assert.rejects(second, /boom/)
    assert.equal(loads, 1)
    assert.equal(await cache.get('a', () => Promise.resolve('recovered')), 'recovered')
  })

  it('does not let invalidated in-flight work overwrite a newer value', async () => {
    const staleGate = deferred<string>()
    const freshGate = deferred<string>()
    const cache = new AsyncTtlCache<string, string>({ ttlMs: 100 })

    const stale = cache.get('a', () => staleGate.promise)
    cache.invalidate('a')
    const fresh = cache.get('a', () => freshGate.promise)
    freshGate.resolve('fresh')
    assert.equal(await fresh, 'fresh')
    staleGate.resolve('stale')
    assert.equal(await stale, 'stale')

    assert.deepEqual(cache.peek('a'), { hit: true, value: 'fresh' })
  })

  it('lets a forced load supersede cached and in-flight work', async () => {
    const staleGate = deferred<string>()
    const cache = new AsyncTtlCache<string, string>({ ttlMs: 100 })
    cache.set('a', 'cached')
    const stale = cache.get('b', () => staleGate.promise)
    const fresh = cache.get('b', () => Promise.resolve('fresh'), {
      force: true,
    })

    assert.equal(await cache.get('a', () => Promise.resolve('wrong')), 'cached')
    assert.equal(await fresh, 'fresh')
    staleGate.resolve('stale')
    assert.equal(await stale, 'stale')
    assert.deepEqual(cache.peek('b'), { hit: true, value: 'fresh' })
  })

  it('supports result-dependent TTLs', () => {
    let now = 0
    const cache = new AsyncTtlCache<string, { ok: boolean }>({
      ttlMs: (value): number => (value.ok ? 100 : 5),
      now: (): number => now,
    })
    cache.set('ok', { ok: true })
    cache.set('failed', { ok: false })
    now = 6

    assert.equal(cache.peek('ok').hit, true)
    assert.equal(cache.peek('failed').hit, false)
  })

  it('evicts the least-recently-used settled value at the bound', () => {
    const cache = new AsyncTtlCache<string, string>({
      ttlMs: 100,
      maxEntries: 2,
    })
    cache.set('a', 'A')
    cache.set('b', 'B')
    cache.peek('a')
    cache.set('c', 'C')

    assert.equal(cache.size, 2)
    assert.equal(cache.peek('a').hit, true)
    assert.equal(cache.peek('b').hit, false)
    assert.equal(cache.peek('c').hit, true)
  })
})
