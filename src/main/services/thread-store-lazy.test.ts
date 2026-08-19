import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GithubPrRef } from '@shared/git/github-pr-url.ts'
import type { Message, Thread } from '@shared/types'
import {
  appendMessage,
  backfillThreadPrRefs,
  loadProjectThreadMetas,
  loadProjectThreads,
  loadThreadMessages,
  saveProjectThread,
} from './thread-store.ts'

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
