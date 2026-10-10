import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { configureThreadStore } from './environment.ts'
import type { Message, Thread } from './thread-types.ts'
import { SqliteThreadIndex, THREAD_INDEX_FILE } from './sqlite-thread-index.ts'
import { buildSideChatThread } from './side-chat.ts'
import {
  appendMessage,
  closeThreadStoreIndexes,
  getThreadMeta,
  loadProjectThreadMetas,
  lookupThreadBacklinks,
  saveProjectThread,
  updateMeta,
} from './thread-store.ts'

function message(id: string, content: string, role: Message['role'] = 'user'): Message {
  return { id, role, content, toolCalls: [], createdAt: 2 }
}

function thread(id: string, fields: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  }
}

const DOCS = 'https://docs.example.com/waitfor'

describe('side-chat metadata and recorded links in the thread store', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'thread-side-chats-'))
    configureThreadStore({ workspaceRoot: () => root })
  })
  afterEach(() => {
    closeThreadStoreIndexes()
    configureThreadStore()
    rmSync(root, { recursive: true, force: true })
  })

  async function seed(): Promise<{ side: Thread; archived: Thread }> {
    const parent = thread('parent', {
      model: 'acp:claude-acp#sonnet',
      messages: [message('m1', 'Why is it flaky?'), message('m2', 'A race.', 'assistant')],
    })
    await saveProjectThread('p', parent)
    const side = buildSideChatThread(parent, { anchorMessageId: 'm2', model: 'acp:codex-acp#fast' })
    const old = buildSideChatThread(parent, { anchorMessageId: 'm1' })
    assert.ok(side && old)
    const archived = { ...old, archivedAt: 5, createdAt: side.createdAt - 1 }
    await saveProjectThread('p', side)
    await saveProjectThread('p', archived)
    await saveProjectThread('p', thread('unrelated'))
    return { side, archived }
  }

  it('keeps archived side chats out of the active metadata list but on disk', async () => {
    const { archived } = await seed()
    const active = await loadProjectThreadMetas('p', { includeArchived: false })
    assert.equal(
      active.some((item) => item.id === archived.id),
      false,
    )
    assert.equal((await getThreadMeta('p', archived.id))?.sideChat?.parentThreadId, 'parent')
  })

  it('round-trips the side-chat link and its read and archive state through metadata', async () => {
    const { side } = await seed()
    assert.deepEqual((await getThreadMeta('p', side.id))?.sideChat, {
      parentThreadId: 'parent',
      anchorMessageId: 'm2',
    })
    await updateMeta('p', side.id, { unreadAt: 9 })
    await updateMeta('p', side.id, { archivedAt: 10 })
    const meta = await getThreadMeta('p', side.id)
    assert.ok(meta)
    assert.equal(meta.unreadAt, 9)
    assert.equal(meta.archivedAt, 10)
    assert.equal(meta.sideChat?.parentThreadId, 'parent')
  })

  it('records links on append, finds backlinks, and keeps them through stale renderer patches', async () => {
    await saveProjectThread('p', thread('a'))
    await saveProjectThread('p', thread('b'))
    await appendMessage(
      'p',
      'a',
      message('a1', `Read ${DOCS}, then https://github.com/acme/widget/pull/1`),
    )
    await appendMessage('p', 'b', message('b1', `Same page: ${DOCS}#section`))
    assert.deepEqual((await getThreadMeta('p', 'a'))?.links, [{ kind: 'url', target: DOCS }])
    assert.deepEqual(
      (await lookupThreadBacklinks('p', 'url', DOCS)).map((row) => row.threadId),
      ['a', 'b'],
    )
    // A renderer patch from before the link was recorded must not erase it.
    await updateMeta('p', 'a', { links: [], title: 'renamed' })
    assert.deepEqual((await getThreadMeta('p', 'a'))?.links, [{ kind: 'url', target: DOCS }])
    assert.equal((await getThreadMeta('p', 'a'))?.title, 'renamed')
    await updateMeta('p', 'b', { archivedAt: 3 })
    assert.deepEqual(
      (await lookupThreadBacklinks('p', 'url', DOCS)).map((row) => row.threadId),
      ['a'],
    )
    closeThreadStoreIndexes()
    assert.deepEqual(
      (await lookupThreadBacklinks('p', 'url', DOCS)).map((row) => row.threadId),
      ['a'],
    )
  })

  it('a rebuild with a repeated thread id keeps only the last copy of its link rows', async () => {
    mkdirSync(join(root, 'p'), { recursive: true })
    const index = new SqliteThreadIndex(join(root, 'p', THREAD_INDEX_FILE))
    try {
      await index.replaceAll([
        thread('dup', { links: [{ kind: 'url', target: 'https://a.test/' }] }),
        thread('dup'),
      ])
      assert.deepEqual(index.backlinks('url', 'https://a.test/'), [])
    } finally {
      index.close()
    }
  })

  it('rebuilds an incompatible v1 projection from the authoritative files', async () => {
    await saveProjectThread('p', thread('a'))
    await appendMessage('p', 'a', message('a1', `See ${DOCS}`))
    await lookupThreadBacklinks('p', 'url', DOCS)
    closeThreadStoreIndexes()
    const path = join(root, 'p', THREAD_INDEX_FILE)
    mkdirSync(join(root, 'p'), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec('PRAGMA user_version=1')
    db.close()
    assert.deepEqual(
      (await lookupThreadBacklinks('p', 'url', DOCS)).map((row) => row.threadId),
      ['a'],
    )
    const reopened = new DatabaseSync(path)
    assert.equal(reopened.prepare('PRAGMA user_version').get()?.['user_version'], 2)
    reopened.close()
  })
})
