import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyReviewTodoUpdates } from './post-turn-orchestration.ts'
import type { ParsedReviewVerdict } from '@copse/agent/review-subagent.ts'
import type { TodoItem } from '@shared/types/todo.ts'

describe('post-turn orchestration helpers', () => {
  it('applyReviewTodoUpdates merges review todo patches', () => {
    const current: TodoItem[] = [
      { id: 'a', content: 'Step 1', status: 'in_progress' },
      { id: 'b', content: 'Step 2', status: 'pending' },
    ]
    const verdict: ParsedReviewVerdict = {
      summary: 'Needs work',
      issuesFound: true,
      requestFollowUp: true,
      todoUpdates: [
        { id: 'a', content: 'Step 1', status: 'completed' },
        { content: 'Fix cleanup', status: 'pending' },
      ],
      followUpPrompt: 'Add unregister',
    }
    const next = applyReviewTodoUpdates(current, verdict)
    assert.equal(next.find((t) => t.id === 'a')?.status, 'completed')
    assert.equal(next.length, 3)
  })

  it('applyReviewTodoUpdates returns a copy when there are no patches', () => {
    const current: TodoItem[] = [{ id: 'a', content: 'Step 1', status: 'pending' }]
    const verdict: ParsedReviewVerdict = {
      summary: 'Looks correct',
      issuesFound: false,
      requestFollowUp: false,
      todoUpdates: [],
      followUpPrompt: null,
    }
    const next = applyReviewTodoUpdates(current, verdict)
    assert.notEqual(next, current)
    assert.deepEqual(next, current)
  })
})
