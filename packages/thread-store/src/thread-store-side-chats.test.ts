import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { configureThreadStore } from './environment.ts'
import type { Message, Thread } from './thread-types.ts'
import { SqliteThreadIndex, THREAD_INDEX_FILE } from './sqlite-thread-index.ts'
import { buildSideChatThread, sideChatsOf } from './side-chat.ts'
import {
  appendMessage,
  closeThreadStoreIndexes,
  getThreadMeta,
  loadProjectThreadMetas,
  loadProjectThreadMetasFromFiles,
  lookupSideChats,
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

describe('side chats and links in the SQLite projection', () => {
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

  it('lists side chats from the index, archived ones only on request', async () => {
    const { side, archived } = await seed()
    assert.deepEqual(
      (await lookupSideChats('p', 'parent')).map((row) => [row.id, row.model, row.anchorMessageId]),
      [[side.id, 'acp:codex-acp#fast', 'm2']],
    )
    assert.deepEqual(
      (await lookupSideChats('p', 'parent', true)).map((row) => [row.id, row.archived]),
      [
        [archived.id, true],
        [side.id, false],
      ],
    )
    assert.deepEqual(await lookupSideChats('p', 'unrelated'), [])
  })

  it('matches the authoritative-file answer and survives an index restart without rereading files', async (t) => {
    await seed()
    const fromIndex = await lookupSideChats('p', 'parent', true)
    assert.deepEqual(
      fromIndex,
      sideChatsOf(await loadProjectThreadMetasFromFiles('p'), 'parent', true),
    )
    closeThreadStoreIndexes()
    t.mock.method(fs, 'open', () => {
      throw new Error('Warm side-chat reads must not reread source files')
    })
    assert.deepEqual(await lookupSideChats('p', 'parent', true), fromIndex)
  })

  it('keeps archived side chats out of the active metadata list but on disk', async () => {
    const { archived } = await seed()
    const active = await loadProjectThreadMetas('p', { includeArchived: false })
    assert.equal(
      active.some((item) => item.id === archived.id),
      false,
    )
    assert.equal((await getThreadMeta('p', archived.id))?.sideChat?.parentThreadId, 'parent')
  })

  it('archiving and reading flow through metadata writes into the projection', async () => {
    const { side } = await seed()
    await updateMeta('p', side.id, { unreadAt: 9 })
    assert.equal((await lookupSideChats('p', 'parent'))[0]?.unread, true)
    await updateMeta('p', side.id, { archivedAt: 10 })
    assert.deepEqual(await lookupSideChats('p', 'parent'), [])
    assert.equal(
      (await lookupSideChats('p', 'parent', true)).find((r) => r.id === side.id)?.archived,
      true,
    )
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

  it('a rebuild with a repeated thread id keeps only the last copy of its side-chat and link rows', async () => {
    mkdirSync(join(root, 'p'), { recursive: true })
    const index = new SqliteThreadIndex(join(root, 'p', THREAD_INDEX_FILE))
    try {
      const link = { parentThreadId: 'parent', anchorMessageId: 'm' }
      await index.replaceAll([
        thread('dup', { sideChat: link, links: [{ kind: 'url', target: 'https://a.test/' }] }),
        thread('dup'),
      ])
      assert.deepEqual(index.sideChatsOf('parent', true), [])
      assert.deepEqual(index.linksOf('dup'), [])
    } finally {
      index.close()
    }
  })

  it('rebuilds an incompatible v1 projection from the authoritative files', async () => {
    await seed()
    await lookupSideChats('p', 'parent')
    closeThreadStoreIndexes()
    const path = join(root, 'p', THREAD_INDEX_FILE)
    mkdirSync(join(root, 'p'), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec('PRAGMA user_version=1')
    db.close()
    assert.equal((await lookupSideChats('p', 'parent')).length, 1)
    const reopened = new DatabaseSync(path)
    assert.equal(reopened.prepare('PRAGMA user_version').get()?.['user_version'], 2)
    reopened.close()
  })
})
