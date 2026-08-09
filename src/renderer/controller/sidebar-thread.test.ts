import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message, Thread } from '@shared/types'
import { compactSidebarThread, sidebarPrRefs, type SidebarThread } from './sidebar-thread.ts'

function message(id: string, content: string): Message {
  return { id, role: 'assistant', content, toolCalls: [], createdAt: 1 }
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    title: 'Fix the thing',
    status: 'running',
    messages: [message('m1', 'no links here')],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

test('a live Thread is readable as a SidebarThread', () => {
  const live: SidebarThread = thread()
  assert.equal(live.title, 'Fix the thing')
  assert.equal(live.status, 'running')
})

test('compacting keeps the row fields and drops the transcript', () => {
  const compacted = compactSidebarThread(
    thread({
      messages: [message('m1', 'x'.repeat(100_000))],
      automation: {
        scheduleId: 'health',
        scheduleName: 'Project health',
        triggeredAt: 10,
      },
    }),
  )

  assert.equal(compacted.id, 't1')
  assert.equal(compacted.title, 'Fix the thing')
  assert.equal(compacted.status, 'running')
  assert.equal(compacted.messages, undefined)
  assert.equal(compacted.automation?.scheduleId, 'health')
})

test('compacting carries the PR scrape over, so the status chip survives it', () => {
  const compacted = compactSidebarThread(
    thread({
      messages: [
        message('m1', 'see https://github.com/copse-dev/agent-pane/pull/12'),
        message('m2', 'and https://github.com/copse-dev/agent-pane/pull/13'),
      ],
    }),
  )

  assert.deepEqual(
    sidebarPrRefs(compacted).map((ref) => ref.number),
    [12, 13],
  )
})

test('a remote agent link is folded into the refs a compacted entry keeps', () => {
  const compacted = compactSidebarThread(
    thread({
      messages: [],
      remoteAgentLink: {
        provider: 'cursor',
        agentId: 'bc-1',
        repo: 'copse-dev/agent-pane',
        prUrl: 'https://github.com/copse-dev/agent-pane/pull/99',
        createdAt: 1,
      },
    }),
  )

  assert.deepEqual(
    sidebarPrRefs(compacted).map((ref) => ref.number),
    [99],
  )
})

test('a live thread re-reads its messages, so a link streamed in mid-turn is found', () => {
  // `appendToken` mutates message content in place, so caching refs against a
  // live thread would miss a PR link the agent posts during its turn.
  const streaming = thread({ messages: [message('m1', 'working…')] })
  assert.deepEqual(sidebarPrRefs(streaming), [])

  const first = streaming.messages[0]
  assert.ok(first)
  first.content += ' opened https://github.com/copse-dev/agent-pane/pull/4'

  assert.deepEqual(
    sidebarPrRefs(streaming).map((ref) => ref.number),
    [4],
  )
})

test('compacting is idempotent', () => {
  const once = compactSidebarThread(
    thread({ messages: [message('m1', 'https://github.com/copse-dev/agent-pane/pull/5')] }),
  )
  assert.deepEqual(compactSidebarThread(once), once)
})
