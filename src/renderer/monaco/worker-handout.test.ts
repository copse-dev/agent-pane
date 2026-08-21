import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkerHandout } from './worker-handout.ts'

// Monaco terminates workers it received from getWorker (idle timer, model-less
// window) and asks getWorker again afterwards. Handing the same instance out
// twice therefore gives Monaco a dead worker and every later diff renders
// uncoloured (#1753) — each instance must be surrendered at most once.

interface FakeWorker {
  id: number
}

function makeFactory(failFirst = 0): {
  create: (label: string) => Promise<FakeWorker>
  created: string[]
} {
  const created: string[] = []
  let failures = failFirst
  let nextId = 0
  return {
    created,
    create: (label: string): Promise<FakeWorker> => {
      created.push(label)
      if (failures > 0) {
        failures--
        return Promise.reject(new Error(`boot failed for ${label}`))
      }
      return Promise.resolve({ id: nextId++ })
    },
  }
}

describe('createWorkerHandout', () => {
  it('hands the warmed instance to the first take, then boots fresh ones', async () => {
    const { create, created } = makeFactory()
    const handout = createWorkerHandout(create)

    const warmed = await handout.warm('editorWorkerService')
    const first = await handout.take('editorWorkerService')
    assert.equal(first, warmed, 'the pre-warmed worker serves the first request')

    const second = await handout.take('editorWorkerService')
    const third = await handout.take('editorWorkerService')
    assert.notEqual(second, first, 'a re-request after termination gets a fresh worker')
    assert.notEqual(third, second, 'every take after the warm one boots its own worker')
    assert.equal(created.length, 3)
  })

  it('reuses one pending warm boot instead of stacking duplicates', async () => {
    const { create, created } = makeFactory()
    const handout = createWorkerHandout(create)

    const [a, b] = await Promise.all([handout.warm('typescript'), handout.warm('typescript')])
    assert.equal(a, b)
    assert.equal(created.length, 1)
  })

  it('keeps labels independent', async () => {
    const { create } = makeFactory()
    const handout = createWorkerHandout(create)

    const editor = await handout.warm('editorWorkerService')
    const json = await handout.take('json')
    assert.notEqual(editor, json)
    const editorTaken = await handout.take('editorWorkerService')
    assert.equal(editorTaken, editor, 'taking one label must not consume another')
  })

  it('drops a failed warm boot so the next request can retry', async () => {
    const { create, created } = makeFactory(1)
    const handout = createWorkerHandout(create)

    await assert.rejects(handout.warm('editorWorkerService'), /boot failed/)
    const recovered = await handout.take('editorWorkerService')
    assert.equal(recovered.id, 0)
    assert.equal(created.length, 2, 'the failure is not cached')
  })

  it('takes never repopulate the warm cache with an owned instance', async () => {
    const { create } = makeFactory()
    const handout = createWorkerHandout(create)

    const owned = await handout.take('editorWorkerService')
    const warmedAfter = await handout.warm('editorWorkerService')
    assert.notEqual(
      warmedAfter,
      owned,
      'an instance Monaco already owns must never be handed out again',
    )
  })

  // A window that never computes a diff (chat-only session, pop-out) must not
  // park its pre-warmed worker forever: the TTL discards an unclaimed warm
  // instance, surrendering it to onDiscard so the caller can terminate it.
  describe('ttl discard of unclaimed warm instances', () => {
    beforeEach(() => {
      mock.timers.enable({ apis: ['setTimeout'] })
    })
    afterEach(() => {
      mock.timers.reset()
    })

    /** Let the discard path's promise callbacks run after a timer tick. */
    async function flushMicrotasks(): Promise<void> {
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }

    it('discards an unclaimed warm instance after the ttl; a later take boots cold', async () => {
      const discarded: FakeWorker[] = []
      const { create, created } = makeFactory()
      const handout = createWorkerHandout(create, {
        ttlMs: 1_000,
        onDiscard: (worker) => discarded.push(worker),
      })

      const warmedWorker = await handout.warm('editorWorkerService')
      mock.timers.tick(1_000)
      await flushMicrotasks()
      assert.deepEqual(discarded, [warmedWorker], 'the expired instance reaches onDiscard')

      const cold = await handout.take('editorWorkerService')
      assert.notEqual(cold, warmedWorker, 'a take after expiry must not receive the discarded one')
      assert.equal(created.length, 2)
    })

    it('a take before expiry claims the instance and cancels the discard', async () => {
      const discarded: FakeWorker[] = []
      const { create, created } = makeFactory()
      const handout = createWorkerHandout(create, {
        ttlMs: 1_000,
        onDiscard: (worker) => discarded.push(worker),
      })

      const warmedWorker = await handout.warm('editorWorkerService')
      mock.timers.tick(999)
      const taken = await handout.take('editorWorkerService')
      assert.equal(taken, warmedWorker, 'a take inside the ttl still gets the warm instance')

      mock.timers.tick(10_000)
      await flushMicrotasks()
      assert.deepEqual(discarded, [], 'an instance Monaco owns must never be discarded')
      assert.equal(created.length, 1)
    })

    it('re-warming after expiry boots a fresh instance with its own ttl', async () => {
      const discarded: FakeWorker[] = []
      const { create } = makeFactory()
      const handout = createWorkerHandout(create, {
        ttlMs: 1_000,
        onDiscard: (worker) => discarded.push(worker),
      })

      const first = await handout.warm('editorWorkerService')
      mock.timers.tick(1_000)
      await flushMicrotasks()

      const second = await handout.warm('editorWorkerService')
      assert.notEqual(second, first, 'the expired instance never comes back')
      mock.timers.tick(1_000)
      await flushMicrotasks()
      assert.deepEqual(discarded, [first, second], 'each unclaimed warm expires on its own timer')
    })

    it('a warm boot that fails is dropped without reaching onDiscard', async () => {
      const discarded: FakeWorker[] = []
      const { create, created } = makeFactory(1)
      const handout = createWorkerHandout(create, {
        ttlMs: 1_000,
        onDiscard: (worker) => discarded.push(worker),
      })

      await assert.rejects(handout.warm('editorWorkerService'), /boot failed/)
      mock.timers.tick(10_000)
      await flushMicrotasks()
      assert.deepEqual(discarded, [], 'there is no instance to discard after a failed boot')

      const recovered = await handout.take('editorWorkerService')
      assert.equal(recovered.id, 0, 'the failure is not cached')
      assert.equal(created.length, 2)
    })

    it('without a ttl a warm instance waits indefinitely', async () => {
      const { create, created } = makeFactory()
      const handout = createWorkerHandout(create)

      const warmedWorker = await handout.warm('editorWorkerService')
      mock.timers.tick(3_600_000)
      const taken = await handout.take('editorWorkerService')
      assert.equal(taken, warmedWorker)
      assert.equal(created.length, 1)
    })
  })
})
