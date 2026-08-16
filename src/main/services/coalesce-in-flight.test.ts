import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createInFlightCoalescer } from './coalesce-in-flight.ts'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('createInFlightCoalescer', () => {
  it('shares one run across callers that overlap on a key', async () => {
    const coalesce = createInFlightCoalescer<string>()
    const gate = deferred<string>()
    let runs = 0

    const first = coalesce('a', () => {
      runs++
      return gate.promise
    })
    const second = coalesce('a', () => {
      runs++
      return gate.promise
    })

    gate.resolve('done')
    assert.deepEqual(await Promise.all([first, second]), ['done', 'done'])
    assert.equal(runs, 1)
  })

  it('keeps distinct keys independent', async () => {
    const coalesce = createInFlightCoalescer<string>()
    const runs: string[] = []
    const run = (key: string) => (): Promise<string> => {
      runs.push(key)
      return Promise.resolve(key)
    }

    assert.deepEqual(await Promise.all([coalesce('a', run('a')), coalesce('b', run('b'))]), [
      'a',
      'b',
    ])
    assert.deepEqual(runs, ['a', 'b'])
  })

  it('runs fresh work once the previous run has settled', async () => {
    const coalesce = createInFlightCoalescer<number>()
    let runs = 0
    const run = (): Promise<number> => Promise.resolve(++runs)

    assert.equal(await coalesce('a', run), 1)
    assert.equal(await coalesce('a', run), 2)
    assert.equal(runs, 2)
  })

  it('propagates a rejection to every joined caller and releases the key', async () => {
    const coalesce = createInFlightCoalescer<string>()
    const gate = deferred<string>()
    let runs = 0
    const failing = (): Promise<string> => {
      runs++
      return gate.promise.then(() => Promise.reject(new Error('boom')))
    }

    const first = coalesce('a', failing)
    const second = coalesce('a', failing)
    gate.resolve('go')

    await assert.rejects(first, /boom/)
    await assert.rejects(second, /boom/)
    assert.equal(runs, 1)

    // The failed key is released rather than pinned to a rejected promise.
    assert.equal(await coalesce('a', () => Promise.resolve('recovered')), 'recovered')
  })
})
