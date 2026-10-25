import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Thread } from '@shared/types'
import {
  ClientActivityReader,
  projectClientActivity,
  projectClientThreadText,
} from './client-activity.ts'

function thread(id: string, settledAt: number): Thread {
  return {
    id,
    title: `Chat ${id}`,
    status: 'idle',
    createdAt: 1,
    updatedAt: 99999,
    lastSettledAt: settledAt,
    lastPromptAt: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
    messages: [
      {
        id: 'secret',
        role: 'assistant',
        content: 'private transcript',
        toolCalls: [],
        createdAt: 1,
      },
    ],
  }
}
describe('interactive client activity projection', () => {
  it('bounds and orders metadata by completion, not rename time, and excludes hidden or unsettled chats', () => {
    const all = Array.from({ length: 25 }, (_, i) => thread(`chat-${String(i)}`, i + 1))
    const blank = thread('blank', 500)
    delete blank.lastPromptAt
    blank.usage = { inputTokens: 0, outputTokens: 0 }
    const data = projectClientActivity(
      [
        {
          id: 'project',
          name: 'Project',
          threads: [
            ...all,
            {
              ...thread('hidden', 500),
              sideChat: { parentThreadId: 'parent', anchorMessageId: 'message' },
            },
            { ...thread('archived', 500), archivedAt: 1 },
            { ...thread('running', 500), status: 'running' },
            thread('active', 500),
            thread('waiting', 500),
            { ...thread('stopped', 500), interruptedTurnAt: 500 },
            blank,
          ],
        },
      ],
      new Set(['active']),
      new Set([JSON.stringify(['project', 'waiting'])]),
    )
    assert.equal(data.recentThreads.length, 20)
    assert.equal(data.recentThreads[0]?.threadId, 'chat-24')
    assert.equal(data.recentThreads.at(-1)?.threadId, 'chat-5')
    assert.equal(data.runningCount, 2)
    assert.equal(data.waitingCount, 1)
    assert.equal(JSON.stringify(data).includes('private transcript'), false)
    assert.deepEqual(Object.keys(data.recentThreads[0]).sort(), [
      'projectId',
      'projectName',
      'settledAt',
      'state',
      'threadId',
      'title',
    ])
  })

  it('keeps project identities, failed runs and legacy completion fallback without leaking paths', () => {
    const row = thread('same', 10)
    const legacy = { ...row, updatedAt: 20 }
    legacy.status = 'error'
    delete legacy.lastSettledAt
    const data = projectClientActivity(
      [
        { id: 'first', name: 'One', threads: [row] },
        {
          id: 'second',
          name: 'Two',
          threads: [legacy],
        },
        { id: '../private', name: 'Invalid', threads: [row] },
      ],
      new Set(),
      new Set(),
    )
    assert.deepEqual(
      data.recentThreads.map((item) => [item.projectId, item.state, item.settledAt]),
      [
        ['second', 'failed', 20],
        ['first', 'finished', 10],
      ],
    )
  })

  it('coalesces readers, caches metadata and refreshes Open validation without retaining caller mutations', async () => {
    let reads = 0
    const gate = Promise.withResolvers<ReturnType<typeof projectClientActivity>>()
    const reader = new ClientActivityReader(() => {
      reads++
      return gate.promise
    })
    const first = reader.read()
    const second = reader.read()
    assert.equal(reads, 1)
    gate.resolve({ recentThreads: [], runningCount: 1, waitingCount: 0 })
    const one = await first
    one.runningCount = 99
    assert.equal((await second).runningCount, 1)
    assert.equal((await reader.read()).runningCount, 1)
    assert.equal(reads, 1)
    await reader.read(true)
    assert.equal(reads, 2)
  })
  it('starts Open validation after an older in-flight read, rather than trusting its stale eligibility', async () => {
    const earlier = Promise.withResolvers<ReturnType<typeof projectClientActivity>>()
    let calls = 0
    const reader = new ClientActivityReader(() => {
      calls++
      return calls === 1
        ? earlier.promise
        : Promise.resolve({ recentThreads: [], runningCount: 0, waitingCount: 0 })
    })
    const ordinary = reader.read()
    const validation = reader.read(true)
    earlier.resolve({
      recentThreads: [
        {
          projectId: 'p',
          projectName: 'Project',
          threadId: 't',
          title: 'No longer eligible',
          state: 'finished',
          settledAt: 1,
        },
      ],
      runningCount: 0,
      waitingCount: 0,
    })
    assert.equal((await ordinary).recentThreads.length, 1)
    assert.equal((await validation).recentThreads.length, 0)
    assert.equal(calls, 2)
  })
})

describe('interactive client text projection', () => {
  it('returns only visible user/assistant text in order, with no reasoning or tool payloads', () => {
    const messages: Thread['messages'] = [
      { id: 'a', role: 'user', content: 'Question\twith tabs', createdAt: 1, toolCalls: [] },
      {
        id: 'b',
        role: 'assistant',
        content: 'Answer\nnext line',
        reasoning: 'private thought',
        createdAt: 2,
        toolCalls: [],
      },
      { id: 'c', role: 'error', content: 'internal diagnostic', createdAt: 3, toolCalls: [] },
      { id: 'd', role: 'assistant', content: ' ', createdAt: 4, toolCalls: [] },
    ]
    assert.deepEqual(projectClientThreadText(messages), {
      messages: [
        { role: 'user', text: 'Question\twith tabs' },
        { role: 'assistant', text: 'Answer\nnext line' },
      ],
      truncated: false,
    })
  })
  it('bounds the newest eight messages and combined text, reporting omissions', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: 'assistant',
      content: String(i),
    })) satisfies Array<Pick<Thread['messages'][number], 'role' | 'content'>>
    const result = projectClientThreadText(messages)
    assert.equal(result.messages.length, 8)
    assert.equal(result.messages[0]?.text, '2')
    assert.equal(result.truncated, true)
    const long = projectClientThreadText([{ role: 'assistant', content: 'x'.repeat(30000) }])
    assert.equal(long.messages[0]?.text.length, 24000)
    assert.equal(long.truncated, true)
  })
})
