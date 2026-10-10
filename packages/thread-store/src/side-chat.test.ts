import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message, Thread } from './thread-types.ts'
import {
  buildSideChatThread,
  sideChatsOf,
  unreadSideChatParents,
  withoutSideChats,
} from './side-chat.ts'

function message(id: string, content: string, role: Message['role'] = 'user'): Message {
  return { id, role, content, toolCalls: [], createdAt: 1 }
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

describe('side chats', () => {
  const parent = thread('parent', {
    model: 'acp:claude-acp#sonnet',
    messages: [
      message('m1', 'Why does the mermaid spec flake?\nMore detail'),
      message('m2', 'Race.', 'assistant'),
    ],
  })

  it('branches from an anchor with its own model and an empty transcript', () => {
    const side = buildSideChatThread(parent, { anchorMessageId: 'm2', model: 'acp:codex-acp#fast' })
    assert.ok(side)
    assert.equal(side.messages.length, 0)
    assert.equal(side.model, 'acp:codex-acp#fast')
    assert.deepEqual(side.sideChat, { parentThreadId: 'parent', anchorMessageId: 'm2' })
    assert.notEqual(side.id, parent.id)
    // Scanned-and-empty caches keep the index from queueing a transcript backfill.
    assert.deepEqual(side.prRefs, [])
    assert.deepEqual(side.links, [])
  })

  it('inherits the parent model when none is chosen and titles from the anchor', () => {
    const side = buildSideChatThread(parent, { anchorMessageId: 'm1' })
    assert.ok(side)
    assert.equal(side.model, 'acp:claude-acp#sonnet')
    assert.equal(side.title, 'Why does the mermaid spec flake?')
  })

  it('refuses an unknown anchor and refuses chains of side chats', () => {
    assert.equal(buildSideChatThread(parent, { anchorMessageId: 'nope' }), null)
    const side = buildSideChatThread(parent, { anchorMessageId: 'm1' })
    assert.ok(side)
    const nested = { ...side, messages: [message('s1', 'hello')] }
    assert.equal(buildSideChatThread(nested, { anchorMessageId: 's1' }), null)
  })

  it('does not mutate the parent', () => {
    const before = JSON.stringify(parent)
    buildSideChatThread(parent, { anchorMessageId: 'm1' })
    assert.equal(JSON.stringify(parent), before)
  })

  it('lists side chats oldest first, hiding archived ones unless asked', () => {
    const link = { parentThreadId: 'parent', anchorMessageId: 'm1' }
    const threads = [
      parent,
      thread('b', { sideChat: link, createdAt: 3 }),
      thread('a', { sideChat: link, createdAt: 2, unreadAt: 9, model: 'x' }),
      thread('old', { sideChat: link, createdAt: 1, archivedAt: 5 }),
      thread('elsewhere', { sideChat: { parentThreadId: 'other', anchorMessageId: 'z' } }),
    ]
    assert.deepEqual(
      sideChatsOf(threads, 'parent').map((row) => row.id),
      ['a', 'b'],
    )
    const all = sideChatsOf(threads, 'parent', true)
    assert.deepEqual(
      all.map((row) => [row.id, row.archived, row.unread]),
      [
        ['old', true, false],
        ['a', false, true],
        ['b', false, false],
      ],
    )
  })

  it('hides side chats from thread browsers and rolls unread up to the parent', () => {
    const link = { parentThreadId: 'parent', anchorMessageId: 'm1' }
    const threads = [
      parent,
      thread('a', { sideChat: link, unreadAt: 9 }),
      thread('archived', { sideChat: link, unreadAt: 9, archivedAt: 1 }),
    ]
    assert.deepEqual(
      withoutSideChats(threads).map((item) => item.id),
      ['parent'],
    )
    assert.deepEqual([...unreadSideChatParents(threads)], ['parent'])
    assert.deepEqual([...unreadSideChatParents([thread('x', { sideChat: link })])], [])
  })

  it('keeps an orphaned side chat listed so it stays reachable', () => {
    const orphan = thread('orphan', { sideChat: { parentThreadId: 'gone', anchorMessageId: 'm' } })
    assert.deepEqual(
      withoutSideChats([parent, orphan]).map((item) => item.id),
      ['parent', 'orphan'],
    )
  })
})
