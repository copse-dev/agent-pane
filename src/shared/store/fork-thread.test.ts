import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message, Thread } from '@shared/types'
import { buildForkedThread, forkThreadTitle } from './fork-thread.ts'

function userMessage(id: string, content: string, extra: Partial<Message> = {}): Message {
  return { id, role: 'user', content, toolCalls: [], createdAt: 1, ...extra }
}

function assistantMessage(id: string, content: string, extra: Partial<Message> = {}): Message {
  return { id, role: 'assistant', content, toolCalls: [], createdAt: 2, ...extra }
}

function thread(messages: Message[], extra: Partial<Thread> = {}): Thread {
  return {
    id: 'src',
    title: 'Fix login',
    status: 'idle',
    messages,
    usage: { inputTokens: 100, outputTokens: 40 },
    createdAt: 10,
    updatedAt: 20,
    ...extra,
  }
}

describe('forkThreadTitle', () => {
  it('marks a first fork and counts subsequent ones instead of nesting suffixes', () => {
    assert.equal(forkThreadTitle('Fix login'), 'Fix login (fork)')
    assert.equal(forkThreadTitle('Fix login (fork)'), 'Fix login (fork 3)')
    assert.equal(forkThreadTitle('Fix login (fork 3)'), 'Fix login (fork 4)')
  })

  it('falls back to a usable title for an unnamed thread', () => {
    assert.equal(forkThreadTitle('   '), 'New Thread (fork)')
  })

  it('caps a long title rather than overflowing the sidebar row', () => {
    const forked = forkThreadTitle('x'.repeat(400))
    assert.ok(forked.length <= 120)
    assert.ok(forked.endsWith('…'))
  })
})

describe('buildForkedThread', () => {
  it('copies the whole conversation into an idle thread with a fresh id', () => {
    const source = thread([userMessage('m1', 'Hello'), assistantMessage('m2', 'Hi')])

    const forked = buildForkedThread(source)

    assert.ok(forked)
    assert.notEqual(forked.id, source.id)
    assert.equal(forked.status, 'idle')
    assert.equal(forked.title, 'Fix login (fork)')
    assert.deepEqual(
      forked.messages.map((m) => m.content),
      ['Hello', 'Hi'],
    )
    // The source is untouched.
    assert.deepEqual(
      source.messages.map((m) => m.id),
      ['m1', 'm2'],
    )
  })

  it('regenerates every message id so a live stream cannot mutate both threads', () => {
    const source = thread([userMessage('m1', 'Hello'), assistantMessage('m2', 'Hi')])

    const forked = buildForkedThread(source)

    const sourceIds = new Set(source.messages.map((m) => m.id))
    assert.ok(forked)
    for (const message of forked.messages) assert.ok(!sourceIds.has(message.id))
    assert.equal(new Set(forked.messages.map((m) => m.id)).size, forked.messages.length)
  })

  it('keeps tool-call ids, which are only ever resolved under a message', () => {
    const source = thread([
      assistantMessage('m1', '', {
        toolCalls: [{ id: 'tc-1', name: 'read_file', args: {}, status: 'done', result: 'ok' }],
      }),
    ])

    const forked = buildForkedThread(source)

    assert.ok(forked)
    assert.equal(forked.messages[0]?.toolCalls[0]?.id, 'tc-1')
    // Deep-copied, not aliased.
    assert.notEqual(forked.messages[0].toolCalls[0], source.messages[0]?.toolCalls[0])
  })

  it('forks through a chosen message, dropping everything after it', () => {
    const source = thread([
      userMessage('m1', 'First'),
      assistantMessage('m2', 'Answer'),
      userMessage('m3', 'Second'),
      assistantMessage('m4', 'Another answer'),
    ])

    const forked = buildForkedThread(source, { throughMessageId: 'm2' })

    assert.deepEqual(
      forked?.messages.map((m) => m.content),
      ['First', 'Answer'],
    )
  })

  it('returns null for an unknown fork point rather than copying everything', () => {
    const source = thread([userMessage('m1', 'First')])
    assert.equal(buildForkedThread(source, { throughMessageId: 'nope' }), null)
  })

  it('returns null when there is nothing to fork', () => {
    assert.equal(buildForkedThread(thread([])), null)
  })

  it('leaves still-queued follow-ups behind — they were never sent', () => {
    const source = thread([
      userMessage('m1', 'First'),
      assistantMessage('m2', 'Answer'),
      userMessage('m3', 'Queued follow-up'),
    ])

    const forked = buildForkedThread(source, { excludeMessageIds: new Set(['m3']) })

    assert.deepEqual(
      forked?.messages.map((m) => m.content),
      ['First', 'Answer'],
    )
  })

  it('resets the usage ledger and drops run-scoped state', () => {
    const source = thread([userMessage('m1', 'Hello')], {
      status: 'running',
      pendingMessages: [{ messageId: 'm9', payload: { content: 'x' }, createdAt: 1 }],
      queuePaused: true,
      archivedAt: 99,
      draftPrompt: 'half-typed',
      currentEpoch: 'epoch-1',
      continuationUsed: 2,
      comparison: {
        status: 'done',
        models: { a: 'a', b: 'b', judge: 'j' },
        reviewA: '',
        reviewB: '',
        synthesis: '',
      },
      contextSnapshot: {
        contextWindow: 1,
        conversationBudget: 1,
        conversationTokens: 1,
        fillRatio: 1,
        updatedAt: 1,
      },
    })

    const forked = buildForkedThread(source)

    assert.ok(forked)
    assert.deepEqual(forked.usage, { inputTokens: 0, outputTokens: 0 })
    assert.equal(forked.status, 'idle')
    assert.equal(forked.pendingMessages, undefined)
    assert.equal(forked.queuePaused, undefined)
    assert.equal(forked.archivedAt, undefined)
    assert.equal(forked.draftPrompt, undefined)
    assert.equal(forked.currentEpoch, undefined)
    assert.equal(forked.continuationUsed, undefined)
    assert.equal(forked.comparison, undefined)
    assert.equal(forked.contextSnapshot, undefined)
  })

  it('carries the model, todos and working brief the fork should continue with', () => {
    const source = thread([userMessage('m1', 'Hello')], {
      model: 'claude-sonnet-4-6',
      workingBrief: 'Make login work',
      todos: [{ id: 't1', content: 'Reproduce', status: 'pending' }],
    })

    const forked = buildForkedThread(source)

    assert.ok(forked)
    assert.equal(forked.model, 'claude-sonnet-4-6')
    assert.equal(forked.workingBrief, 'Make login work')
    assert.deepEqual(forked.todos, [{ id: 't1', content: 'Reproduce', status: 'pending' }])
    assert.notEqual(forked.todos[0], source.todos?.[0])
  })

  it('never inherits a linked worktree — its path is derived from the thread id', () => {
    const source = thread([userMessage('m1', 'Hello')], {
      gitBranch: 'copse/thread-src',
      worktreeChoice: 'worktree',
      worktree: {
        path: '/tmp/wt',
        branch: 'copse/thread-src',
        baseBranch: 'main',
        baseCommit: 'a'.repeat(40),
        createdAt: 1,
        seededFromDirtyProject: false,
      },
    })

    const forked = buildForkedThread(source)

    assert.ok(forked)
    assert.equal(forked.worktree, undefined)
    assert.equal(forked.worktreeChoice, undefined)
    // The branch binding belonged to the worktree, so it does not carry either.
    assert.equal(forked.gitBranch, undefined)
  })

  it('keeps the branch binding when the source ran in the shared checkout', () => {
    const source = thread([userMessage('m1', 'Hello')], { gitBranch: 'feature/login' })
    assert.equal(buildForkedThread(source)?.gitBranch, 'feature/login')
  })

  it('drops derived per-message state that belongs to the source run', () => {
    const source = thread([
      assistantMessage('m1', 'Done', {
        review: { status: 'done', summary: 'looks good' },
        hookCards: [
          {
            id: 'h1',
            kind: 'execution',
            status: 'allow',
            event: 'stop',
            hookId: 'x',
            executor: 'function',
            durationMs: 1,
            parseOk: true,
          },
        ],
      }),
    ])

    const forked = buildForkedThread(source)

    assert.ok(forked)
    assert.equal(forked.messages[0]?.review, undefined)
    assert.equal(forked.messages[0]?.hookCards, undefined)
  })
})
