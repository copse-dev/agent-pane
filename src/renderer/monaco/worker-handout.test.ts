import { describe, it } from 'node:test'
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
})
