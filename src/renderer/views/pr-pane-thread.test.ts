import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { prNewThreadDraft, prNewThreadTitle, startPrDiscussThread } from './pr-pane-thread.ts'

const PR = {
  number: 42,
  title: 'Add GitHub PR panel tab',
  url: 'https://github.com/copse-dev/copse-panel/pull/42',
}

describe('prNewThreadDraft / prNewThreadTitle', () => {
  it('seeds a markdown link the PR pane can re-discover from chat', () => {
    assert.equal(
      prNewThreadDraft(PR),
      'Help with [#42 — Add GitHub PR panel tab](https://github.com/copse-dev/copse-panel/pull/42).',
    )
    assert.equal(prNewThreadTitle(PR), 'PR #42: Add GitHub PR panel tab')
  })
})

describe('startPrDiscussThread', () => {
  it('opens a titled draft thread without overriding the default checkout', () => {
    const store = createStore({
      projects: [{ id: 'p1', path: '/proj', name: 'Proj' }],
      activeProjectId: 'p1',
      threads: [
        {
          id: 't-old',
          title: 'Existing',
          status: 'idle',
          messages: [{ id: 'm1', role: 'user', content: 'hi', toolCalls: [], createdAt: 1 }],
          usage: { inputTokens: 0, outputTokens: 0 },
          draftPrompt: 'unsaved composer text',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeThreadId: 't-old',
    })

    let flushed = 0
    store.on('composer_draft_flush', () => {
      flushed += 1
    })

    const threadId = startPrDiscussThread(store, PR)
    const thread = store.getState().threads.find((t) => t.id === threadId)

    assert.equal(flushed, 1)
    assert.equal(store.getState().activeThreadId, threadId)
    assert.notEqual(threadId, 't-old')
    assert.ok(thread)
    assert.equal(thread.title, 'PR #42: Add GitHub PR panel tab')
    assert.equal(thread.draftPrompt, prNewThreadDraft(PR))
    // No checkout choice is pinned on the thread, so the first message follows
    // the automatic policy (isolated worktree).
    assert.equal(thread.worktreeChoice, undefined)
  })
})
