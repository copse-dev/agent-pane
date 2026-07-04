import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runSerialized, drainWriteQueue } from './write-queue.ts'

const tick = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0))

describe('write-queue', () => {
  it('serializes ops on the same key (no lost concurrent updates)', async () => {
    // Simulate the read-modify-write race: two callers each read the shared
    // value, append, and write back. Without serialization one update is lost.
    let store: string[] = []
    const slowAppend = (item: string): Promise<void> =>
      runSerialized('k', async () => {
        const current = store // read
        await tick() // yield: lets a concurrent caller interleave if unserialized
        store = [...current, item] // write
      })

    await Promise.all([slowAppend('a'), slowAppend('b')])
    assert.deepEqual([...store].sort(), ['a', 'b'])
  })

  it('runs ops on the same key in submission order', async () => {
    const order: number[] = []
    const mk = (n: number): Promise<void> =>
      runSerialized('order', async () => {
        await tick()
        order.push(n)
      })
    await Promise.all([mk(1), mk(2), mk(3)])
    assert.deepEqual(order, [1, 2, 3])
  })

  it('does not serialize across different keys', async () => {
    let bStarted = false
    const a = runSerialized('a', async () => {
      // a stays pending until b has had a chance to start
      await tick()
      assert.equal(bStarted, true)
    })
    const b = runSerialized('b', () => {
      bStarted = true
    })
    await Promise.all([a, b])
  })

  it('a rejecting op does not poison later submissions for the key', async () => {
    await assert.rejects(runSerialized('p', () => Promise.reject(new Error('boom'))))
    const ok = await runSerialized('p', () => 'recovered')
    assert.equal(ok, 'recovered')
  })

  it('drainWriteQueue resolves after queued writes settle', async () => {
    let done = false
    void runSerialized('drain', async () => {
      await tick()
      done = true
    })
    await drainWriteQueue()
    assert.equal(done, true)
  })
})
