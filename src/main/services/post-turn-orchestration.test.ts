import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyReviewTodoUpdates,
  reviewSpendApprovalBody,
  runPostTurnReviewCycle,
  runPreReviewTodoGate,
  type PostTurnReviewOutcome,
  type RunParentContinuationOptions,
  type RunPostTurnReviewCycleOptions,
} from './post-turn-orchestration.ts'
import { MAX_POST_TURN_REVIEW_CYCLES } from '@shared/todos/todo-logic.ts'
import { DEFAULT_POST_TURN_REVIEW_CYCLES } from '@copse/agent/plugins/post-turn-review-plugin.ts'
import type { ParsedReviewVerdict } from '@copse/agent/review-subagent.ts'
import type { StreamChunk } from '@shared/types'
import type { TodoItem } from '@shared/types/todo.ts'
import type { ContinuationGrant } from '@copse/agent/hooks/continuation-budget.ts'
import type { LLMMessage, LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { at } from '@shared/array-utils.ts'
import { isRecord } from '@copse/std/unknown-value.ts'

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

  it('does no further post turn on a failing review when maxCycles is 1', async () => {
    const h = newHarness()
    await runPostTurnReviewCycle(
      baseOptions(h, {
        maxCycles: 1,
        runReviewOnce: () => {
          h.reviews += 1
          return Promise.resolve(outcome(verdict({ issuesFound: true, requestFollowUp: true })))
        },
      }),
    )
    // The failing verdict is still reported — it just doesn't buy a remediation
    // turn or a re-review.
    assert.equal(h.reviews, 1)
    assert.equal(h.remediations.length, 0)
    assert.equal(reviewChunks(h.chunks).at(-1)?.issuesFound, true)
  })

  it('runs the configured number of passes when the reviewer keeps failing', async () => {
    const h = newHarness()
    await runPostTurnReviewCycle(
      baseOptions(h, {
        maxCycles: 3,
        runReviewOnce: () => {
          h.reviews += 1
          return Promise.resolve(outcome(verdict({ requestFollowUp: true })))
        },
      }),
    )
    // Three reviews with a remediation turn between each pair; the last pass
    // breaks without remediating.
    assert.equal(h.reviews, 3)
    assert.equal(h.remediations.length, 2)
  })

  it('falls back to the shipped default for an unset or corrupt maxCycles', async () => {
    // The plugin default and the host constant must stay in lockstep: an unset
    // `maxReviewCycles` has to reproduce the pre-setting behaviour exactly.
    assert.equal(DEFAULT_POST_TURN_REVIEW_CYCLES, MAX_POST_TURN_REVIEW_CYCLES)
    for (const maxCycles of [undefined, 0, -1, Number.POSITIVE_INFINITY]) {
      const h = newHarness()
      await runPostTurnReviewCycle(
        baseOptions(h, {
          ...(maxCycles === undefined ? {} : { maxCycles }),
          runReviewOnce: () => {
            h.reviews += 1
            return Promise.resolve(outcome(verdict({ requestFollowUp: true })))
          },
        }),
      )
      // 0 / negatives floor to one pass (the review always runs at least once —
      // turning it off is the plugin toggle's job); undefined / non-finite land on
      // the default of 2.
      assert.equal(h.reviews, maxCycles === undefined || !Number.isFinite(maxCycles) ? 2 : 1)
    }
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

/**
 * A minimal provider for `runPreReviewTodoGate` tests: it recognizes the pre-
 * review nudge (`OPEN_TODOS_PRE_REVIEW_NUDGE`, "reconcile the task plan") and
 * either calls `update_todos` (via `closesTodos`) or answers with plain text
 * that does nothing, so a test can control whether an attempt "makes edits".
 */
function preReviewProvider(closesTodos: boolean, todos: TodoItem[]): LLMProvider {
  return {
    async *stream(messages: LLMMessage[]): AsyncGenerator<ProviderStreamChunk> {
      const last = messages.at(-1)
      const content =
        last && 'content' in last && typeof last.content === 'string' ? last.content : ''
      if (content.includes('reconcile the task plan')) {
        if (closesTodos) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: 'todo-1',
              name: 'update_todos',
              args: {
                merge: true,
                todos: todos.map((t) => ({ ...t, status: 'completed' as const })),
              },
            },
          }
        } else {
          yield { type: 'text', text: 'still working on it' }
        }
      }
      yield { type: 'done' }
    },
  }
}

function preReviewOptions(
  todos: TodoItem[],
  provider: LLMProvider,
  over: Partial<RunParentContinuationOptions> = {},
): RunParentContinuationOptions {
  return {
    provider,
    messages: [{ role: 'user', content: 'do the task' }],
    tools: [{ name: 'update_todos', description: 'x', parameters: {} }],
    contextWindow: 100_000,
    toolSchemaReserve: 0,
    signal: new AbortController().signal,
    usageModel: 'test-model',
    onChunk: (): void => {},
    getOpenTodos: () => todos,
    setTodos: (t): void => {
      todos.length = 0
      todos.push(...t)
    },
    userNudge: '',
    maxSteps: 4,
    executeTool: async (name, args): Promise<string> => {
      if (name === 'update_todos' && isRecord(args) && Array.isArray(args['todos'])) {
        for (const update of args['todos']) {
          if (!isRecord(update) || typeof update['id'] !== 'string') continue
          const existing = todos.find((t) => t.id === update['id'])
          if (existing) existing.status = 'completed'
        }
      }
      return 'ok'
    },
    ...over,
  }
}

describe('runPreReviewTodoGate (#1410)', () => {
  it('emits a budget-exhausted note naming the open todos and attempt count', async () => {
    const todos: TodoItem[] = [
      { id: 'a', content: 'Wire up the export button', status: 'pending' },
      { id: 'b', content: 'Add a loading spinner', status: 'in_progress' },
    ]
    // Provider answers with plain text (no tool call) so the plan stays open;
    // the single grant is spent on that one attempt.
    const chunks: StreamChunk[] = []
    const opts = preReviewOptions(todos, preReviewProvider(false, todos), {
      continuationBudget: grantBudget(1),
      onChunk: (c) => chunks.push(c),
    })
    await runPreReviewTodoGate(opts)
    const note = chunks.find(
      (c): c is Extract<StreamChunk, { type: 'text' }> =>
        c.type === 'text' && c.text.includes('auto-continuation budget'),
    )
    assert.ok(note, 'a budget-exhausted note is emitted')
    assert.ok(note.text.includes('Wire up the export button'))
    assert.ok(note.text.includes('Add a loading spinner'))
    assert.ok(note.text.includes('1 closeout attempt ran'))
    assert.ok(note.text.includes('made no tool calls'))
    // The note is persisted into the turn's own message history, so it
    // survives a reload of the thread.
    assert.ok(
      opts.messages.some(
        (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content === note.text,
      ),
    )
  })

  it('emits nothing when the budget runs out but no todos remain open', async () => {
    const todos: TodoItem[] = [{ id: 'a', content: 'Wire up the export button', status: 'pending' }]
    const chunks: StreamChunk[] = []
    const opts = preReviewOptions(todos, preReviewProvider(true, todos), {
      continuationBudget: grantBudget(1),
      onChunk: (c) => chunks.push(c),
    })
    await runPreReviewTodoGate(opts)
    assert.equal(todos[0]?.status, 'completed')
    assert.ok(
      !chunks.some((c) => c.type === 'text' && c.text.includes('auto-continuation budget')),
      'no note once the plan is clean',
    )
  })

  it('does not re-report when the budget was already exhausted before this gate ran', async () => {
    // Simulates the finalize closeout loop (upstream) having already spent the
    // whole shared budget and surfaced its own note — this gate must not
    // misattribute zero attempts of its own as "no closeout attempt ran".
    const todos: TodoItem[] = [{ id: 'a', content: 'Wire up the export button', status: 'pending' }]
    const chunks: StreamChunk[] = []
    const opts = preReviewOptions(todos, preReviewProvider(false, todos), {
      continuationBudget: grantBudget(0),
      onChunk: (c) => chunks.push(c),
    })
    await runPreReviewTodoGate(opts)
    assert.ok(
      !chunks.some((c) => c.type === 'text' && c.text.includes('auto-continuation budget')),
      'this gate stays silent when it made no attempts of its own',
    )
  })

  it('a fresh budget that finishes the plan emits no note', async () => {
    const todos: TodoItem[] = [{ id: 'a', content: 'Wire up the export button', status: 'pending' }]
    const chunks: StreamChunk[] = []
    const opts = preReviewOptions(todos, preReviewProvider(true, todos), {
      continuationBudget: grantBudget(5),
      onChunk: (c) => chunks.push(c),
    })
    await runPreReviewTodoGate(opts)
    assert.equal(todos[0]?.status, 'completed')
    assert.ok(!chunks.some((c) => c.type === 'text' && c.text.includes('auto-continuation budget')))
  })
})
