import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { LLMMessage, Message, Thread } from '@shared/types'
import {
  getProjectThread,
  loadAgentHistory,
  saveAgentHistory,
  saveProjectThread,
  stageThreadHistoryMutation,
} from './thread-store.ts'
import {
  applyThreadHistoryEdit,
  loadThreadHistorySnapshot,
  undoThreadHistoryEdit,
  type ThreadHistoryEditRuntime,
} from './thread-history-edit.ts'

function message(id: string, role: Message['role'], content: string, createdAt: number): Message {
  return { id, role, content, toolCalls: [], createdAt }
}

function thread(id: string): Thread {
  return {
    id,
    title: 'Editable history',
    status: 'idle',
    messages: [
      message('u1', 'user', 'Use PostgreSQL', 1),
      message('a1', 'assistant', 'I will use PostgreSQL.', 2),
      message('u2', 'user', 'Actually use SQLite', 3),
      message('a2', 'assistant', 'Switching to SQLite.', 4),
    ],
    usage: { inputTokens: 10, outputTokens: 10 },
    currentEpoch: 'old-turn-tree',
    continuationUsed: 2,
    contextSnapshot: {
      contextWindow: 100,
      conversationBudget: 80,
      conversationTokens: 20,
      fillRatio: 0.25,
      updatedAt: 4,
    },
    createdAt: 1,
    updatedAt: 4,
  }
}

describe('thread history editing', () => {
  let root: string
  let previousRoot: string | undefined
  let runtime: ThreadHistoryEditRuntime
  let locked: boolean
  let forgets: number

  beforeEach(async () => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-history-edit-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
    locked = false
    forgets = 0
    runtime = {
      begin: (): boolean => {
        if (locked) return false
        locked = true
        return true
      },
      end: (): void => {
        locked = false
      },
      forgetAgentHistory: (): void => {
        forgets += 1
      },
    }
    await saveProjectThread('project', thread('thread'))
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('replaces the transcript and provider history under one thread id', async () => {
    const snapshot = await loadThreadHistorySnapshot('project', 'thread')
    const result = await applyThreadHistoryEdit(
      'project',
      'thread',
      {
        expectedRevision: snapshot.revision,
        messages: snapshot.messages.map((item) => ({
          id: item.id,
          content: item.id === 'u1' ? 'Use SQLite' : item.content,
          included: item.id !== 'u2',
        })),
      },
      runtime,
    )

    assert.deepEqual(
      result.thread.messages.map((item) => [item.id, item.content]),
      [
        ['u1', 'Use SQLite'],
        ['a1', 'I will use PostgreSQL.'],
        ['a2', 'Switching to SQLite.'],
      ],
    )
    assert.deepEqual(await loadAgentHistory('project', 'thread'), [
      { role: 'user', content: 'Use SQLite' },
      { role: 'assistant', content: 'I will use PostgreSQL.' },
      { role: 'assistant', content: 'Switching to SQLite.' },
    ])
    const saved = await getProjectThread('project', 'thread')
    assert(saved)
    assert.equal(saved.id, 'thread')
    assert.equal(saved.contextSnapshot, undefined)
    assert.equal(saved.currentEpoch, undefined)
    assert.equal(result.canUndo, true)
    assert.equal(forgets, 1)
    assert.equal(locked, false)
  })

  it('rejects a stale editor without changing either history', async () => {
    const snapshot = await loadThreadHistorySnapshot('project', 'thread')
    const changed = thread('thread')
    const firstMessage = changed.messages[0]
    assert(firstMessage)
    changed.messages[0] = { ...firstMessage, content: 'Changed elsewhere' }
    await saveProjectThread('project', changed)

    await assert.rejects(
      applyThreadHistoryEdit(
        'project',
        'thread',
        { expectedRevision: snapshot.revision, messages: snapshot.messages },
        runtime,
      ),
      /changed while the editor was open/,
    )
    assert.equal(
      (await getProjectThread('project', 'thread'))?.messages[0]?.content,
      'Changed elsewhere',
    )
    assert.deepEqual(await loadAgentHistory('project', 'thread'), [])
  })

  it('undo restores the exact provider sidecar rather than a transcript approximation', async () => {
    const originalHistory: LLMMessage[] = [
      { role: 'user', content: 'Use PostgreSQL' },
      { role: 'user', content: 'Continue where you left off.' },
      { role: 'assistant', content: 'I will use PostgreSQL.' },
    ]
    await saveAgentHistory('project', 'thread', originalHistory)
    const snapshot = await loadThreadHistorySnapshot('project', 'thread')
    const edited = await applyThreadHistoryEdit(
      'project',
      'thread',
      {
        expectedRevision: snapshot.revision,
        messages: snapshot.messages.map((item) => ({
          id: item.id,
          content: item.content.replaceAll('PostgreSQL', 'SQLite'),
          included: true,
        })),
      },
      runtime,
    )
    assert.equal((await loadThreadHistorySnapshot('project', 'thread')).canUndo, true)

    const undone = await undoThreadHistoryEdit('project', 'thread', edited.revision, runtime)

    assert.deepEqual(undone.thread.messages, thread('thread').messages)
    assert.equal(undone.thread.currentEpoch, undefined)
    assert.equal(undone.thread.continuationUsed, undefined)
    assert.equal(undone.thread.contextSnapshot, undefined)
    assert.deepEqual(await loadAgentHistory('project', 'thread'), originalHistory)
    assert.equal(undone.canUndo, false)
    assert.equal(forgets, 2)
  })

  it('recovers an interrupted multi-file replacement before the thread can be read', async () => {
    const original = thread('thread')
    const originalHistory: LLMMessage[] = [{ role: 'user', content: 'Use PostgreSQL' }]
    await saveAgentHistory('project', 'thread', originalHistory)
    await stageThreadHistoryMutation('project', 'thread', {
      thread: original,
      agentHistory: originalHistory,
      hadAgentHistory: true,
    })

    const partial = thread('thread')
    partial.messages = [message('u1', 'user', 'Half-written replacement', 1)]
    await saveProjectThread('project', partial)
    await saveAgentHistory('project', 'thread', [
      { role: 'user', content: 'Half-written replacement' },
    ])

    assert.deepEqual((await getProjectThread('project', 'thread'))?.messages, original.messages)
    assert.deepEqual(await loadAgentHistory('project', 'thread'), originalHistory)
  })

  it('blocks reconstruction when attachment context is not recoverable', async () => {
    const withAttachment = thread('attached')
    const firstMessage = withAttachment.messages[0]
    assert(firstMessage)
    withAttachment.messages[0] = {
      ...firstMessage,
      attachments: [{ kind: 'file', label: 'schema.sql' }],
    }
    await saveProjectThread('project', withAttachment)

    const snapshot = await loadThreadHistorySnapshot('project', 'attached')
    assert.match(snapshot.blockedReason ?? '', /expanded model context/)
    await assert.rejects(
      applyThreadHistoryEdit(
        'project',
        'attached',
        { expectedRevision: snapshot.revision, messages: snapshot.messages },
        runtime,
      ),
      /expanded model context/,
    )
  })
})
