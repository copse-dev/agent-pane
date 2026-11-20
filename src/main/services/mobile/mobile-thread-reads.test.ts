import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '@shared/types'
import { MobileThreadReads } from './mobile-thread-reads.ts'

function message(id: string): Message {
  return { id, role: 'user', content: id, toolCalls: [], createdAt: 1 }
}

/** A store whose revision and transcript the test moves by hand. */
function store(): {
  revisions: Map<string, string>
  loads: string[]
  revision: (projectId: string, threadId: string) => Promise<string>
  load: (projectId: string, threadId: string) => Promise<Message[]>
} {
  const revisions = new Map<string, string>()
  const loads: string[] = []
  return {
    revisions,
    loads,
    revision: (_projectId, threadId) => Promise.resolve(revisions.get(threadId) ?? 'r0'),
    load: (_projectId, threadId) => {
      loads.push(threadId)
      return Promise.resolve([message(`${threadId}@${revisions.get(threadId) ?? 'r0'}`)])
    },
  }
}

describe('mobile thread reads', () => {
  it('folds a thread once while its revision holds', async () => {
    const source = store()
    const reads = new MobileThreadReads(source.revision, source.load)
    const first = await reads.read('p', 't')
    assert.equal(await reads.read('p', 't'), first, 'the same transcript, not an equal copy')
    await reads.read('p', 't')
    assert.deepEqual(source.loads, ['t'])
  })

  it('folds again as soon as the store reports a new revision', async () => {
    const source = store()
    const reads = new MobileThreadReads(source.revision, source.load)
    await reads.read('p', 't')
    source.revisions.set('t', 'r1')
    assert.equal((await reads.read('p', 't'))[0]?.id, 't@r1')
    assert.deepEqual(source.loads, ['t', 't'])
  })

  it('labels a transcript with the revision taken before its read began', async () => {
    // A write landing mid-read must cost one more read, never hide itself.
    const source = store()
    const gate = Promise.withResolvers<undefined>()
    const reads = new MobileThreadReads(source.revision, async (projectId, threadId) => {
      await gate.promise
      return source.load(projectId, threadId)
    })
    const pending = reads.read('p', 't')
    await Promise.resolve()
    source.revisions.set('t', 'r1')
    gate.resolve(undefined)
    assert.equal((await pending)[0]?.id, 't@r1')
    await reads.read('p', 't')
    assert.deepEqual(source.loads, ['t', 't'], 'the revision moved, so the next read folds again')
  })

  it('shares one read between requests that arrive together', async () => {
    // Every image of an opened thread asks at once.
    const source = store()
    const reads = new MobileThreadReads(source.revision, source.load)
    const results = await Promise.all(Array.from({ length: 6 }, () => reads.read('p', 't')))
    assert.deepEqual(source.loads, ['t'])
    assert.ok(results.every((result) => result === results[0]))
  })

  it('does not keep a failed read', async () => {
    const source = store()
    let fail = true
    const reads = new MobileThreadReads(source.revision, (projectId, threadId) => {
      if (fail) return Promise.reject(new Error('unreadable'))
      return source.load(projectId, threadId)
    })
    await assert.rejects(reads.read('p', 't'), /unreadable/)
    fail = false
    assert.equal((await reads.read('p', 't'))[0]?.id, 't@r0')
  })

  it('keeps only the most recently read threads', async () => {
    const source = store()
    const reads = new MobileThreadReads(source.revision, source.load, { limit: 2 })
    await reads.read('p', 'a')
    await reads.read('p', 'b')
    await reads.read('p', 'a')
    await reads.read('p', 'c')
    await reads.read('p', 'a')
    await reads.read('p', 'b')
    assert.deepEqual(source.loads, ['a', 'b', 'c', 'b'])
  })

  it('keeps threads of the same id in different projects apart', async () => {
    const source = store()
    const loaded: string[] = []
    const reads = new MobileThreadReads(source.revision, (projectId, threadId) => {
      loaded.push(projectId)
      return source.load(projectId, threadId)
    })
    await reads.read('p', 't')
    await reads.read('q', 't')
    assert.deepEqual(loaded, ['p', 'q'])
  })

  it('lets go of every transcript once no phone has read for a while', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const source = store()
    const reads = new MobileThreadReads(source.revision, source.load, { idleMs: 1000 })
    await reads.read('p', 't')
    t.mock.timers.tick(900)
    await reads.read('p', 't')
    t.mock.timers.tick(900)
    await reads.read('p', 't')
    assert.deepEqual(source.loads, ['t'], 'each read restarts the idle clock')
    t.mock.timers.tick(1000)
    await reads.read('p', 't')
    assert.deepEqual(source.loads, ['t', 't'])
  })
})
