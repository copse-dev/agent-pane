import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SettingsLifecycle } from './lifecycle.ts'

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => {
    throw new Error('not initialised')
  }
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Settings section lifecycle', () => {
  it('defers invisible work, aborts it on navigation, and ignores late failure', async () => {
    const slow = deferred(),
      errors: unknown[] = []
    let sourcesCalls = 0,
      aborted = false
    const lifecycle = new SettingsLifecycle(
      {
        customise: {
          refresh: async (_snapshot, signal): Promise<void> => {
            sourcesCalls += 1
            signal.addEventListener('abort', () => {
              aborted = true
            })
            await slow.promise
            throw new Error('late discovery failure')
          },
        },
      },
      (_id, error) => errors.push(error),
    )
    await lifecycle.show(['appearance'], {})
    assert.equal(sourcesCalls, 0)
    const work = lifecycle.show(['customise'], {})
    await lifecycle.show(['general'], {})
    assert.equal(aborted, true)
    slow.resolve()
    await work
    assert.deepEqual(errors, [])
  })
  it('retains loaded editors on re-entry and reloads them for a new open', async () => {
    let calls = 0
    const lifecycle = new SettingsLifecycle(
      {
        general: {
          retainDrafts: true,
          refresh: async (): Promise<void> => {
            calls += 1
          },
        },
      },
      () => {},
    )
    await lifecycle.show(['general'], {})
    await lifecycle.show(['appearance'], {})
    await lifecycle.show(['general'], {})
    assert.equal(calls, 1)
    lifecycle.reset()
    await lifecycle.show(['general'], {})
    assert.equal(calls, 2)
  })
  it('loads only matched sections during search and aborts work when they leave results', async () => {
    const slow = deferred(),
      signals: AbortSignal[] = []
    const lifecycle = new SettingsLifecycle(
      {
        customise: {
          refresh: async (_snapshot, signal): Promise<void> => {
            signals.push(signal)
            await slow.promise
          },
        },
        usage: {
          refresh: async (_snapshot, signal): Promise<void> => {
            signals.push(signal)
            await slow.promise
          },
        },
      },
      () => {},
    )
    const work = lifecycle.show(['customise', 'usage'], {})
    assert.equal(signals.length, 2)
    const next = lifecycle.show(['usage'], {})
    assert.equal(signals[0]?.aborted, true)
    assert.equal(signals[1]?.aborted, false)
    lifecycle.cancel()
    assert.equal(signals[1].aborted, true)
    slow.resolve()
    await Promise.all([work, next])
  })
})
