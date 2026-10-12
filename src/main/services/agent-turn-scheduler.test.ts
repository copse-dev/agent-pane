import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AgentTurnScheduler, parseMaxActiveTurns } from './agent-turn-scheduler.ts'

function latch(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const signal = (): AbortSignal => new AbortController().signal
const noQueue = (): void => {
  throw new Error('Unexpected queue')
}

describe('primary turn admission', () => {
  it('starts at most the configured number, admits FIFO and releases on failure', async () => {
    const scheduler = new AgentTurnScheduler(1)
    const hold = latch()
    const started: number[] = []
    let queued = 0
    const first = scheduler.run(signal(), noQueue, async () => {
      started.push(1)
      await hold.promise
      throw new Error('provider failed')
    })
    const second = scheduler.run(
      signal(),
      () => {
        queued++
      },
      async () => {
        started.push(2)
      },
    )
    const third = scheduler.run(
      signal(),
      () => {
        queued++
      },
      async () => {
        started.push(3)
      },
    )
    await Promise.resolve()
    assert.deepEqual(started, [1])
    assert.equal(queued, 2)
    hold.release()
    await assert.rejects(first, /provider failed/)
    await Promise.all([second, third])
    assert.deepEqual(started, [1, 2, 3])
  })

  it('cancels a queued turn promptly without starting it or blocking its successor', async () => {
    const scheduler = new AgentTurnScheduler(1)
    const hold = latch()
    const first = scheduler.run(signal(), noQueue, () => hold.promise)
    const controller = new AbortController()
    let cancelledStarted = false
    const cancelled = scheduler.run(
      controller.signal,
      () => {},
      async () => {
        cancelledStarted = true
      },
    )
    const last = scheduler.run(
      signal(),
      () => {},
      async () => 'finished',
    )
    controller.abort()
    await assert.rejects(cancelled, { name: 'AbortError' })
    assert.equal(cancelledStarted, false)
    hold.release()
    await first
    assert.equal(await last, 'finished')
  })

  it('keeps other queued turns when a queue notification aborts and throws', async () => {
    const scheduler = new AgentTurnScheduler(1)
    const hold = latch()
    const first = scheduler.run(signal(), noQueue, () => hold.promise)
    const next = scheduler.run(
      signal(),
      () => {},
      async () => 'next',
    )
    const controller = new AbortController()
    const cancelled = scheduler.run(
      controller.signal,
      () => {
        controller.abort()
        throw new Error('notification failed')
      },
      async () => assert.fail('started'),
    )
    await assert.rejects(cancelled, { name: 'AbortError' })
    hold.release()
    await first
    assert.equal(await next, 'next')
  })

  it('rechecks cancellation after admission before starting provider work', async () => {
    const scheduler = new AgentTurnScheduler(1)
    const controller = new AbortController()
    const run = scheduler.run(controller.signal, noQueue, async () => assert.fail('started'))
    controller.abort()
    await assert.rejects(run, { name: 'AbortError' })
    await scheduler.run(signal(), noQueue, async () => {})
  })

  it('lets nested turns share admission without deadlocking a full pool', async () => {
    const scheduler = new AgentTurnScheduler(1)
    const value = await scheduler.run(signal(), noQueue, () =>
      scheduler.run(signal(), noQueue, async () => 'nested'),
    )
    assert.equal(value, 'nested')
  })

  it('does not let detached callbacks reuse an expired parent lease', async () => {
    const scheduler = new AgentTurnScheduler(1)
    const detachedGate = latch()
    let detached: Promise<void> | undefined
    let queued = false
    await scheduler.run(signal(), noQueue, async () => {
      detached = detachedGate.promise.then(() =>
        scheduler.run(
          signal(),
          () => {
            queued = true
          },
          async () => {},
        ),
      )
    })
    const hold = latch()
    const active = scheduler.run(signal(), noQueue, () => hold.promise)
    detachedGate.release()
    await Promise.resolve()
    assert.equal(queued, true)
    hold.release()
    await Promise.all([active, detached])
  })

  it('supports an explicit unlimited override and rejects malformed configuration', async () => {
    assert.equal(parseMaxActiveTurns('0'), 0)
    assert.equal(parseMaxActiveTurns('2'), 2)
    for (const value of [undefined, '', '-1', '2.5', '2garbage', 'Infinity', '9007199254740992']) {
      assert.equal(parseMaxActiveTurns(value), 4)
    }
    const scheduler = new AgentTurnScheduler(0)
    const hold = latch()
    const runs = Array.from({ length: 8 }, () =>
      scheduler.run(signal(), noQueue, () => hold.promise),
    )
    hold.release()
    await Promise.all(runs)
  })
})
