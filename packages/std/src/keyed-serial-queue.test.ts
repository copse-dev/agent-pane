import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createKeyedSerialQueue } from './keyed-serial-queue.ts'

const tick = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0))

describe('createKeyedSerialQueue', () => {
  it('runs ops on one key one at a time, in submission order', async () => {
    const queue = createKeyedSerialQueue<string>()
    const events: string[] = []
    const op = (name: string) => async (): Promise<void> => {
      events.push(`start ${name}`)
      await tick()
      events.push(`end ${name}`)
    }
    await Promise.all([queue.run('k', op('a')), queue.run('k', op('b')), queue.run('k', op('c'))])
    assert.deepEqual(events, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
  })

  it('runs different keys independently', async () => {
    const queue = createKeyedSerialQueue<string>()
    let bStarted = false
    const a = queue.run('a', async () => {
      await tick()
      assert.equal(bStarted, true)
    })
    const b = queue.run('b', () => {
      bStarted = true
    })
    await Promise.all([a, b])
  })

  it('separate queues do not share keys', async () => {
    const first = createKeyedSerialQueue<string>()
    const second = createKeyedSerialQueue<string>()
    let secondRan = false
    const blocked = first.run('k', async () => {
      await tick()
      assert.equal(secondRan, true)
    })
    await second.run('k', () => {
      secondRan = true
    })
    await blocked
  })

  it('serializes on object identity', async () => {
    const queue = createKeyedSerialQueue<object>()
    const tab = {}
    const order: number[] = []
    await Promise.all([
      queue.run(tab, async () => {
        await tick()
        order.push(1)
      }),
      queue.run(tab, () => {
        order.push(2)
      }),
    ])
    assert.deepEqual(order, [1, 2])
  })

  it('passes each op its own result or rejection and keeps going after a failure', async () => {
    const queue = createKeyedSerialQueue<string>()
    const failed = queue.run('p', () => Promise.reject(new Error('boom')))
    const thrown = queue.run('p', () => {
      throw new Error('sync boom')
    })
    const recovered = queue.run('p', () => 'recovered')
    await assert.rejects(failed, /boom/)
    await assert.rejects(thrown, /sync boom/)
    assert.equal(await recovered, 'recovered')
  })

  it('starts an op asynchronously even when the key is idle', async () => {
    const queue = createKeyedSerialQueue<string>()
    let started = false
    const pending = queue.run('idle', () => {
      started = true
    })
    assert.equal(started, false)
    await pending
    assert.equal(started, true)
  })

  it('drain waits for queued ops and the follow-ups they enqueue', async () => {
    const queue = createKeyedSerialQueue<string>()
    const late = Promise.withResolvers<undefined>()
    let lateDone = false
    const first = queue.run('first', () => {
      void queue.run('late', async () => {
        await late.promise
        lateDone = true
      })
    })
    let drained = false
    const drain = queue.drain().then(() => {
      drained = true
    })
    await first
    await tick()
    assert.equal(drained, false)
    late.resolve(undefined)
    await drain
    assert.equal(lateDone, true)
  })

  it('drain resolves at once when nothing is queued, including after ops settle', async () => {
    const queue = createKeyedSerialQueue<string>()
    await queue.drain()
    await queue.run('done', () => undefined)
    await tick()
    // The settled key was dropped, so this drain has nothing to wait on.
    let drained = false
    void queue.drain().then(() => {
      drained = true
    })
    await Promise.resolve()
    assert.equal(drained, true)
  })
})
