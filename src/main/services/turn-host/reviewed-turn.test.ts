import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LLMMessage } from '@copse/llm/wire-types.ts'
import type { StoredThreadPlan } from '@copse/thread-store/plan-schema.ts'
import { reviewedTurnSchema, type ReviewedTurn } from './reviewed-turn.ts'
import { appToHostSchema } from './turn-host-protocol.ts'
import { reviewedRequest } from './turn-host.ts'

const HISTORY: LLMMessage[] = [
  { role: 'user', content: 'Earlier prompt' },
  { role: 'assistant', content: [{ id: 'call-1', name: 'read_file', args: { path: 'a.ts' } }] },
  { role: 'tool', toolResults: [{ toolCallId: 'call-1', result: 'export {}' }] },
  { role: 'assistant', content: 'Read it.' },
]

const PLAN: StoredThreadPlan = {
  meta: {
    planId: 'plan-1',
    threadId: 't1',
    title: 'Refactor',
    status: 'draft',
    currentRevision: 2,
    createdAt: 1,
    updatedAt: 2,
  },
  comments: [],
  approval: null,
  completion: null,
  body: '## Goal\nRefactor the loader.',
  contentHash: 'hash',
}

function wire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

describe('reviewed turn', () => {
  it('crosses the line unchanged: approved prompt, frozen history and plan, kept bubble', () => {
    const reviewed: ReviewedTurn = {
      content: 'Keep refactoring the loader',
      history: HISTORY,
      plan: PLAN,
      optimisticMessageId: 'bubble-1',
      preserveOptimisticDisplay: true,
      attachments: [{ kind: 'paste', label: 'notes', placement: 'inline', content: 'x' }],
    }
    const parsed = reviewedTurnSchema.safeParse(wire(reviewed))
    assert.ok(parsed.success, parsed.success ? '' : parsed.error.message)
    assert.deepEqual(parsed.data, reviewed)
  })

  it('refuses a dispatch that carries no review', () => {
    const dispatch = { t: 'dispatch', id: 'd1', projectId: 'p1', threadId: 't1', payload: 'Hi' }
    assert.equal(appToHostSchema.safeParse(dispatch).success, false)
    const reviewed = { ...dispatch, reviewed: { content: 'Hi', history: [], plan: null } }
    assert.equal(appToHostSchema.safeParse(reviewed).success, true)
  })

  it('refuses history the agent loop could not have kept', () => {
    const forged = { content: 'Hi', history: [{ role: 'root', content: 'x' }], plan: null }
    assert.equal(reviewedTurnSchema.safeParse(forged).success, false)
  })

  it('runs the approved prompt, not the payload the window sent, with the frozen inputs', () => {
    const request = reviewedRequest(
      'p1',
      't1',
      { userContent: 'What the window sent', invokedSkills: [], priorTodos: [], model: 'm' },
      {
        content: 'What the human approved',
        history: HISTORY,
        plan: PLAN,
        attachments: [{ kind: 'file', label: 'a.ts' }],
      },
    )
    assert.equal(request.payload.userContent, 'What the human approved')
    assert.equal(request.payload.model, 'm')
    assert.equal(request.protectedHistory, HISTORY)
    assert.equal(request.protectedPlan, PLAN)
    assert.equal(request.protectedHumanStart?.content, 'What the human approved')
    // Attachment chips are display for a bubble the window keeps; an edited
    // prompt gets none.
    assert.equal(request.protectedHumanStart.preserveOptimisticDisplay, undefined)
    assert.equal(request.protectedHumanStart.attachments, undefined)
  })

  it('keeps the bubble and its chips only when review made no edit', () => {
    const attachments = [{ kind: 'file' as const, label: 'a.ts' }]
    const request = reviewedRequest(
      'p1',
      't1',
      { userContent: 'Same', invokedSkills: [], priorTodos: [] },
      {
        content: 'Same',
        history: [],
        plan: null,
        optimisticMessageId: 'bubble-1',
        preserveOptimisticDisplay: true,
        attachments,
      },
    )
    assert.equal(request.protectedHumanStart?.preserveOptimisticDisplay, true)
    assert.deepEqual(request.protectedHumanStart.attachments, attachments)
  })
})
