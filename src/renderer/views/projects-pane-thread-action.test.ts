import '../../../tests/setup-dom.ts'
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountProjectsPane } from './projects-pane.ts'
import { setAttentionThreads, resetAttention } from '../controller/attention.ts'
import { orderSidebarRows, orderSidebarThreads } from '../controller/thread-order.ts'

it('sorts action signals across projects and preserves stable ties and reverse order', () => {
  const threads = ['complete', 'action', 'unknown', 'action2'].map((id) => ({
    id,
    title: id,
    status: 'idle' as const,
  }))
  const rank = (thread: { id: string }): number =>
    thread.id.startsWith('action') ? 0 : thread.id === 'unknown' ? 1 : 2
  assert.deepEqual(
    orderSidebarThreads(threads, 'action', false, rank).map((t) => t.id),
    ['action', 'action2', 'unknown', 'complete'],
  )
  assert.deepEqual(
    orderSidebarRows(
      threads.map((thread) => ({ projectId: 'p', thread })),
      'action',
      true,
      rank,
    ).map((row) => row.thread.id),
    ['complete', 'unknown', 'action2', 'action'],
  )
})

it('shows partial onboarding, ranks real attention first, and never starts agent work', async () => {
  const makeThread = (id: string): Thread => ({
    id,
    title: id,
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
  })
  const store = createStore({
    projects: [{ id: 'p', path: '/work', name: 'work' }],
    activeProjectId: 'p',
    expandedProjectId: 'p',
    activeThreadId: 'complete',
    threads: ['complete', 'unknown', 'action', 'approval'].map(makeThread),
    sidebarThreadSort: 'action',
  })
  const base = createFakeApi()
  let agentCalls = 0
  const host = document.createElement('div')
  document.body.append(host)
  setAttentionThreads(store, 'approval', ['approval'])
  const cleanup = mountProjectsPane(host, store, {
    ...base,
    agent: {
      ...base.agent,
      run: async () => {
        agentCalls++
      },
    },
    threads: {
      ...base.threads,
      actionState: async () => ({
        total: 4,
        assessed: 2,
        pending: 2,
        assessing: false,
        budgetLimited: false,
        entries: [
          {
            projectId: 'p',
            threadId: 'complete',
            assessment: {
              status: 'complete',
              reason: 'Delivered.',
              evidence: [],
              revision: '1',
              assessedAt: 10,
              source: 'judge',
            },
          },
          {
            projectId: 'p',
            threadId: 'action',
            assessment: {
              status: 'needs-action',
              reason: 'Validation results were never inspected.',
              evidence: ['m1'],
              revision: '2',
              assessedAt: 10,
              source: 'judge',
            },
          },
        ],
      }),
    },
  })
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(
      Array.from(host.querySelectorAll('.chat-title')).map((title) => title.textContent),
      ['approval', 'action', 'unknown', 'complete'],
    )
    assert.ok(
      host.querySelector('.thread-action-progress')?.textContent.includes('2 of 4 assessed'),
    )
    assert.equal(
      host.querySelector('[data-thread-id="action"] .thread-action-status')?.getAttribute('title'),
      'Validation results were never inspected.',
    )
    assert.equal(
      host.querySelector('[data-thread-id="unknown"] .thread-action-status')?.textContent,
      'Not assessed',
    )
    assert.equal(agentCalls, 0)
  } finally {
    cleanup()
    host.remove()
    resetAttention()
  }
})
