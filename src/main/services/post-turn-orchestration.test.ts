import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyReviewTodoUpdates,
  reviewSpendApprovalBody,
  runPostTurnReviewCycle,
  type PostTurnReviewOutcome,
  type RunPostTurnReviewCycleOptions,
} from './post-turn-orchestration.ts'
import type { ParsedReviewVerdict } from '@copse/agent/review-subagent.ts'
import type { StreamChunk } from '@shared/types'
import type { TodoItem } from '@shared/types/todo.ts'
import type { ContinuationGrant } from '@copse/agent/hooks/continuation-budget.ts'
import { at } from '@shared/array-utils.ts'

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

  it('reviewSpendApprovalBody names the model and mentions the free local alternative', () => {
    const body = reviewSpendApprovalBody('openrouter:openai/gpt-4o')
    assert.match(body, /openrouter:openai\/gpt-4o/)
    assert.match(body, /billable/i)
    assert.match(body, /local review model/i)
  })
})

/** A verdict with sensible defaults; override the fields a case exercises. */
function verdict(overrides: Partial<ParsedReviewVerdict> = {}): ParsedReviewVerdict {
  return {
    summary: 'Looks correct',
    issuesFound: false,
    requestFollowUp: false,
    todoUpdates: [],
    followUpPrompt: null,
    ...overrides,
  }
}

function outcome(v: ParsedReviewVerdict): PostTurnReviewOutcome {
  return { summary: v.summary, verdict: v, usage: { inputTokens: 0, outputTokens: 0 } }
}

/** A budget grant that yields `available` grants then refuses. */
function grantBudget(available: number): ContinuationGrant {
  let used = 0
  return {
    tryGrant: (): boolean => {
      if (used >= available) return false
      used += 1
      return true
    },
    remaining: () => Math.max(0, available - used),
  }
}

interface Harness {
  chunks: StreamChunk[]
  reviews: number
  remediations: string[]
  todos: TodoItem[]
}

function baseOptions(
  harness: Harness,
  over: Partial<RunPostTurnReviewCycleOptions> = {},
): RunPostTurnReviewCycleOptions {
  return {
    reviewUsageModel: 'openrouter:openai/gpt-4o',
    nothingToReview: false,
    reviewApproved: true,
    signal: new AbortController().signal,
    getTodos: () => harness.todos,
    setTodos: (t): void => {
      harness.todos = t
    },
    emitChunk: (c) => harness.chunks.push(c),
    continuationBudget: grantBudget(5),
    runReviewOnce: (): Promise<PostTurnReviewOutcome> => {
      harness.reviews += 1
      return Promise.resolve(outcome(verdict()))
    },
    runRemediationTurn: (nudge): Promise<{ madeEdits: boolean }> => {
      harness.remediations.push(nudge)
      return Promise.resolve({ madeEdits: true })
    },
    ...over,
  }
}

function newHarness(): Harness {
  return { chunks: [], reviews: 0, remediations: [], todos: [] }
}

function reviewChunks(chunks: StreamChunk[]): Extract<StreamChunk, { type: 'post_turn_review' }>[] {
  return chunks.filter(
    (c): c is Extract<StreamChunk, { type: 'post_turn_review' }> => c.type === 'post_turn_review',
  )
}

describe('runPostTurnReviewCycle (E3)', () => {
  it('emits a single skipped chunk and runs no review when nothing to review', async () => {
    const h = newHarness()
    await runPostTurnReviewCycle(baseOptions(h, { nothingToReview: true }))
    const reviews = reviewChunks(h.chunks)
    assert.equal(reviews.length, 1)
    assert.equal(at(reviews, 0).status, 'skipped')
    assert.match(at(reviews, 0).summary, /Nothing to review/)
    assert.equal(h.reviews, 0)
    assert.equal(h.remediations.length, 0)
  })

  it('skips with the model name when a billable review was not approved', async () => {
    const h = newHarness()
    await runPostTurnReviewCycle(baseOptions(h, { reviewApproved: false }))
    const reviews = reviewChunks(h.chunks)
    assert.equal(reviews.length, 1)
    assert.equal(at(reviews, 0).status, 'skipped')
    assert.match(at(reviews, 0).summary, /was not approved/)
    assert.match(at(reviews, 0).summary, /gpt-4o/)
    assert.equal(h.reviews, 0)
  })

  it('reports "Review cancelled." when the run was aborted before an unapproved review', async () => {
    const h = newHarness()
    const ac = new AbortController()
    ac.abort()
    await runPostTurnReviewCycle(baseOptions(h, { reviewApproved: false, signal: ac.signal }))
    assert.equal(at(reviewChunks(h.chunks), 0).summary, 'Review cancelled.')
  })

  it('runs one review and no remediation when the verdict requests no follow-up', async () => {
    const h = newHarness()
    await runPostTurnReviewCycle(
      baseOptions(h, {
        runReviewOnce: () => {
          h.reviews += 1
          return Promise.resolve(outcome(verdict({ issuesFound: true, requestFollowUp: false })))
        },
      }),
    )
    assert.equal(h.reviews, 1)
    assert.equal(h.remediations.length, 0)
    const reviews = reviewChunks(h.chunks)
    assert.deepEqual(
      reviews.map((c) => c.status),
      ['running', 'done'],
    )
    assert.equal(reviews.at(-1)?.issuesFound, true)
  })

  it('remediates while the reviewer asks for follow-up, bounded by the local cap (2)', async () => {
    const h = newHarness()
    await runPostTurnReviewCycle(
      baseOptions(h, {
        runReviewOnce: () => {
          h.reviews += 1
          return Promise.resolve(outcome(verdict({ requestFollowUp: true })))
        },
      }),
    )
    // MAX_POST_TURN_REVIEW_CYCLES = 2: two reviews, one remediation between them,
    // then the last cycle breaks without remediating.
    assert.equal(h.reviews, 2)
    assert.equal(h.remediations.length, 1)
  })

  it('stops remediating when the shared budget is exhausted (decision 5)', async () => {
    const h = newHarness()
    await runPostTurnReviewCycle(
      baseOptions(h, {
        continuationBudget: grantBudget(0),
        runReviewOnce: () => {
          h.reviews += 1
          return Promise.resolve(outcome(verdict({ requestFollowUp: true })))
        },
      }),
    )
    // First review requests follow-up, but the budget grants nothing → no
    // remediation, only the one review.
    assert.equal(h.reviews, 1)
    assert.equal(h.remediations.length, 0)
  })

  it('stops when a remediation turn makes no edits', async () => {
    const h = newHarness()
    await runPostTurnReviewCycle(
      baseOptions(h, {
        runReviewOnce: () => {
          h.reviews += 1
          return Promise.resolve(outcome(verdict({ requestFollowUp: true })))
        },
        runRemediationTurn: (nudge) => {
          h.remediations.push(nudge)
          return Promise.resolve({ madeEdits: false })
        },
      }),
    )
    assert.equal(h.reviews, 1)
    assert.equal(h.remediations.length, 1)
  })

  it('applies the review verdict todo patches via setTodos', async () => {
    const h = newHarness()
    h.todos = [{ id: 'a', content: 'Step 1', status: 'in_progress' }]
    await runPostTurnReviewCycle(
      baseOptions(h, {
        runReviewOnce: () => {
          h.reviews += 1
          return Promise.resolve(
            outcome(
              verdict({
                todoUpdates: [{ id: 'a', content: 'Step 1', status: 'completed' }],
              }),
            ),
          )
        },
      }),
    )
    assert.equal(h.todos.find((t) => t.id === 'a')?.status, 'completed')
  })

  it('emits a post_turn_review error and stops when the review throws', async () => {
    const h = newHarness()
    await runPostTurnReviewCycle(
      baseOptions(h, {
        runReviewOnce: () => Promise.reject(new Error('review boom')),
      }),
    )
    const reviews = reviewChunks(h.chunks)
    assert.equal(reviews.at(-1)?.status, 'error')
    assert.equal(h.remediations.length, 0)
  })
})
