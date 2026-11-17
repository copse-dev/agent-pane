import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { withTimeout } from './with-timeout.ts'

describe('withTimeout', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] })
  })
  afterEach(() => {
    mock.timers.reset()
  })

  it('settles with the promise when it wins, without calling onTimeout', async () => {
    let calls = 0
    const result = await withTimeout(Promise.resolve('value'), 1_000, () => {
      calls += 1
      return 'fallback'
    })
    assert.equal(result, 'value')
    mock.timers.tick(1_000)
    assert.equal(calls, 0)
  })

  it('resolves with the fallback onTimeout returns', async () => {
    const pending = withTimeout(new Promise<string>(() => undefined), 50, () => 'timeout')
    mock.timers.tick(50)
    const outcome: string = await pending
    assert.equal(outcome, 'timeout')
  })

  it('rejects with the exact error onTimeout throws', async () => {
    class DeadlineError extends Error {}
    const thrown = new DeadlineError('took too long')
    const pending = withTimeout(new Promise<never>(() => undefined), 50, () => {
      throw thrown
    })
    mock.timers.tick(50)
    await assert.rejects(pending, (error) => error === thrown)
  })

  it('runs onTimeout synchronously on the timer, before the race settles', () => {
    const order: string[] = []
    void withTimeout(new Promise<never>(() => undefined), 10, () => {
      order.push('onTimeout')
    }).then(() => order.push('settled'))
    mock.timers.tick(10)
    assert.deepEqual(order, ['onTimeout'])
  })

  it('passes a rejection from the promise through and clears the timer', async () => {
    let calls = 0
    const failure = new Error('boom')
    await assert.rejects(
      withTimeout(Promise.reject(failure), 1_000, () => {
        calls += 1
      }),
      (error) => error === failure,
    )
    mock.timers.tick(1_000)
    assert.equal(calls, 0)
  })

  it('observes a rejection from the abandoned promise after the timeout', async () => {
    const unhandled = mock.fn()
    process.on('unhandledRejection', unhandled)
    try {
      let fail: (error: Error) => void = () => undefined
      const late = new Promise<never>((_resolve, reject) => {
        fail = reject
      })
      const pending = withTimeout(late, 10, () => 'timeout')
      mock.timers.tick(10)
      assert.equal(await pending, 'timeout')
      fail(new Error('late'))
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(unhandled.mock.callCount(), 0)
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('infers a literal sentinel without a cast', async () => {
    const pending = withTimeout(
      new Promise<{ kind: 'update' }>(() => undefined),
      5,
      () => 'timeout',
    )
    mock.timers.tick(5)
    const outcome = await pending
    // Compile-time check: the union keeps the literal, so narrowing works.
    if (outcome === 'timeout') assert.ok(true)
    else assert.fail(`unexpected ${outcome.kind}`)
  })
})
