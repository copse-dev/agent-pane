import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GithubPrRef } from '@shared/git/github-pr-url.ts'
import type { Message, Thread } from '@shared/types'
import {
  appendMessage,
  backfillThreadPrRefs,
  deleteProjectThread,
  loadProjectThreadMetas,
  loadProjectThreads,
  loadThreadMessages,
  recordThreadPrRefs,
  saveProjectThread,
  updateMeta,
} from './thread-store.ts'
import { runSerialized } from './storage/write-queue.ts'

/**
 * The metadata-only load path that makes opening a large project cheap, and the
 * PR-ref cache that lets the sidebar keep its chip without a transcript.
 */

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function userMsg(id: string, content: string): Message {
  return { id, role: 'user', content, toolCalls: [], createdAt: 10 }
}

function metaOnDisk(root: string, projectId: string, threadId: string): Record<string, unknown> {
  const raw = readFileSync(join(root, projectId, threadId, 'meta.json'), 'utf8')
  const parsed: unknown = JSON.parse(raw)
  return typeof parsed === 'object' && parsed !== null ? { ...parsed } : {}
}

describe('thread-store metadata-only load', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-lazy-store-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('returns metadata with no transcript, flagged as unloaded', async () => {
    await saveProjectThread('p', thread('t1', { messages: [userMsg('m1', 'hello')] }))

    const [loaded] = await loadProjectThreadMetas('p')

    assert.ok(loaded)
    assert.equal(loaded.title, 't1')
    assert.deepEqual(loaded.messages, [])
    assert.equal(
      loaded.messagesLoaded,
      false,
      'a thread with messages on disk must report its transcript as unloaded',
    )
  })

  it('flags a genuinely empty thread as loaded, so blank-thread handling still works', async () => {
    await saveProjectThread('p', thread('empty'))

    const [loaded] = await loadProjectThreadMetas('p')

    assert.ok(loaded)
    assert.equal(loaded.messagesLoaded, true)
  })

  it('leaves the whole-thread reader untouched for the callers that need messages', async () => {
    await saveProjectThread('p', thread('t1', { messages: [userMsg('m1', 'hello')] }))

    const [loaded] = await loadProjectThreads('p')

    assert.ok(loaded)
    assert.equal(loaded.messages.length, 1)
    assert.equal(loaded.messages[0]?.content, 'hello')
  })

  it('loads one thread’s transcript on demand', async () => {
    await saveProjectThread('p', thread('t1', { messages: [userMsg('m1', 'hello')] }))

    const messages = await loadThreadMessages('p', 't1')

    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.content, 'hello')
  })

  it('omits archived threads, as the sidebar does', async () => {
    await saveProjectThread('p', thread('live'))
    await saveProjectThread('p', thread('gone', { archivedAt: 99 }))

    const ids = (await loadProjectThreadMetas('p', { includeArchived: false })).map((t) => t.id)

    assert.deepEqual(ids, ['live'])
  })
})

describe('thread-store meta cache', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-meta-cache-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('serves a second load from the cache without re-reading meta.json', async () => {
    await saveProjectThread('p', thread('t1'))

    const [first] = await loadProjectThreadMetas('p')
    // Rewrite the file behind the cache's back; a re-read would see the change.
    writeFileSync(join(root, 'p', 't1', 'meta.json'), `${JSON.stringify({ id: 't1' })}\n`)

    const [second] = await loadProjectThreadMetas('p')

    assert.equal(first?.title, 't1')
    assert.deepEqual(second, first, 'a warm load must serve the cached snapshot')
  })

  it('reflects writes made through the store after a cached load', async () => {
    await saveProjectThread('p', thread('t1'))
    await loadProjectThreadMetas('p')

    await saveProjectThread('p', thread('t1', { title: 'renamed', updatedAt: 5 }))

    const [loaded] = await loadProjectThreadMetas('p')
    assert.equal(loaded?.title, 'renamed')
  })

  it('reflects meta patches made through the store after a cached load', async () => {
    await saveProjectThread('p', thread('t1'))
    await loadProjectThreadMetas('p')

    await updateMeta('p', 't1', { title: 'patched' })

    const [loaded] = await loadProjectThreadMetas('p')
    assert.equal(loaded?.title, 'patched')
  })

  it('drops a deleted thread from the next cached load', async () => {
    await saveProjectThread('p', thread('t1'))
    await saveProjectThread('p', thread('t2'))
    await loadProjectThreadMetas('p')

    await deleteProjectThread('p', 't1')

    const ids = (await loadProjectThreadMetas('p')).map((t) => t.id)
    assert.deepEqual(ids, ['t2'])
  })

  it('reflects a spine append after a cached load (messagesLoaded flips)', async () => {
    await saveProjectThread('p', thread('t1'))
    const [before] = await loadProjectThreadMetas('p')
    assert.equal(before?.messagesLoaded, true)

    await appendMessage('p', 't1', userMsg('m1', 'hello'))

    const [after] = await loadProjectThreadMetas('p')
    assert.equal(after?.messagesLoaded, false, 'the spine append must invalidate the cache')
  })

  it('does not let one project’s cache leak into another', async () => {
    await saveProjectThread('p1', thread('shared-id', { title: 'one' }))
    await saveProjectThread('p2', thread('shared-id', { title: 'two' }))

    const [first] = await loadProjectThreadMetas('p1')

    const [second] = await loadProjectThreadMetas('p2')
    assert.equal(first?.title, 'one')
    assert.equal(second?.title, 'two')
  })

  it('serves the two includeArchived variants independently', async () => {
    await saveProjectThread('p', thread('live'))
    await saveProjectThread('p', thread('gone', { archivedAt: 99 }))

    await loadProjectThreadMetas('p', { includeArchived: false })
    const all = await loadProjectThreadMetas('p')

    assert.deepEqual(all.map((t) => t.id).sort(), ['gone', 'live'])
  })

  it('still reads fresh from disk when a load is the first in the process', async () => {
    await saveProjectThread('p', thread('t1', { title: 'from disk' }))

    const [loaded] = await loadProjectThreadMetas('p')

    assert.equal(loaded?.title, 'from disk')
  })
})

describe('thread-store PR-ref cache', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-lazy-prrefs-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('records a PR link onto thread metadata as the message lands', async () => {
    await saveProjectThread('p', thread('t1'))

    await appendMessage(
      'p',
      't1',
      userMsg('m1', 'see https://github.com/acme/widget/pull/42 for the fix'),
    )

    const meta = metaOnDisk(root, 'p', 't1')
    const refs = meta['prRefs']
    assert.ok(Array.isArray(refs))
    assert.equal(refs.length, 1)
    const first: unknown = refs[0]
    assert.ok(typeof first === 'object' && first !== null)
    assert.equal(Reflect.get(first, 'number'), 42)
  })

  it('records a PR ref handed to it directly, with no message text to scrape', async () => {
    await saveProjectThread('p', thread('t1'))

    const refs = await recordThreadPrRefs('p', 't1', [
      { url: 'https://github.com/acme/widget/pull/99', owner: 'acme', repo: 'widget', number: 99 },
    ])

    assert.equal(refs?.[0]?.number, 99)
    const stored = metaOnDisk(root, 'p', 't1')['prRefs']
    assert.ok(Array.isArray(stored))
    assert.equal(stored.length, 1)
  })

  it('reports nothing to push when the ref is already cached', async () => {
    await saveProjectThread('p', thread('t1'))
    const ref = {
      url: 'https://github.com/acme/widget/pull/99',
      owner: 'acme',
      repo: 'widget',
      number: 99,
    }

    await recordThreadPrRefs('p', 't1', [ref])

    assert.equal(await recordThreadPrRefs('p', 't1', [ref]), null)
  })

  it('surfaces the cached refs through the metadata-only load', async () => {
    await saveProjectThread('p', thread('t1'))
    await appendMessage('p', 't1', userMsg('m1', 'https://github.com/acme/widget/pull/7'))

    const [loaded] = await loadProjectThreadMetas('p')

    assert.equal(loaded?.prRefs?.[0]?.number, 7)
  })

  it('backfills threads written before the cache existed, and reports them', async () => {
    // `saveProjectThread` writes meta directly, so this thread has messages with
    // a PR link but no `prRefs` — exactly an upgrade from an older build.
    await saveProjectThread(
      'p',
      thread('old', { messages: [userMsg('m1', 'https://github.com/acme/widget/pull/5')] }),
    )
    await saveProjectThread('p', thread('plain', { messages: [userMsg('m2', 'no links here')] }))

    const batches: Array<{ threadId: string; prRefs: GithubPrRef[] }> = []
    await backfillThreadPrRefs('p', (refs) => batches.push(...refs))

    assert.deepEqual(
      batches.map((b) => b.threadId),
      ['old'],
      'only threads that actually have PR links are reported',
    )
    assert.equal(batches[0]?.prRefs[0]?.number, 5)
    // A thread with no links must still be marked as scanned, or the backfill
    // would re-read the whole project on every open forever.
    assert.deepEqual(metaOnDisk(root, 'p', 'plain')['prRefs'], [])
  })

  it('invalidates a warm metadata snapshot when the background backfill writes', async () => {
    await saveProjectThread(
      'p',
      thread('old', { messages: [userMsg('m1', 'https://github.com/acme/widget/pull/5')] }),
    )
    const [before] = await loadProjectThreadMetas('p')
    assert.equal(before?.prRefs, undefined)

    await backfillThreadPrRefs('p', () => undefined)

    const [after] = await loadProjectThreadMetas('p')
    assert.equal(after?.prRefs?.[0]?.number, 5)
  })

  it('queues the backfill commit behind foreground project writes', async () => {
    await saveProjectThread(
      'p',
      thread('old', { messages: [userMsg('m1', 'https://github.com/acme/widget/pull/5')] }),
    )
    // An independent project provides a deterministic pacing yardstick while
    // p's queue is held; this is more reliable than assuming a few event-loop
    // ticks are enough for the backfill's asynchronous transcript read.
    await saveProjectThread('p2', thread('other', { messages: [userMsg('m2', 'hello')] }))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const hold = runSerialized('thread-store:p', async () => {
      await gate
    })
    const backfill = backfillThreadPrRefs('p', () => undefined)

    try {
      for (let i = 0; i < 5; i++) await loadProjectThreads('p2')
      assert.equal(
        metaOnDisk(root, 'p', 'old')['prRefs'],
        undefined,
        'the metadata commit must not bypass the held project queue',
      )
    } finally {
      release()
    }
    await hold
    await backfill
    const refs = metaOnDisk(root, 'p', 'old')['prRefs']
    assert.ok(Array.isArray(refs))
    assert.equal(refs.length, 1)
  })

  it('does not re-scan a thread that has already been backfilled', async () => {
    await saveProjectThread(
      'p',
      thread('old', { messages: [userMsg('m1', 'https://github.com/acme/widget/pull/5')] }),
    )
    await backfillThreadPrRefs('p', () => undefined)

    const second: Array<{ threadId: string; prRefs: GithubPrRef[] }> = []
    await backfillThreadPrRefs('p', (refs) => second.push(...refs))

    assert.deepEqual(second, [], 'a second pass must be a no-op')
  })
})
