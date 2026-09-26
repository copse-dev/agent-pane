import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseAgentRunPayload, REVIEW_CONTEXT_CHAR_CAP } from './parse-agent-run-payload.ts'

describe('parseAgentRunPayload', () => {
  it('parses plain text prompts', () => {
    assert.deepEqual(parseAgentRunPayload('hello'), {
      userContent: 'hello',
      invokedSkills: [],
      priorTodos: [],
    })
  })

  it('parses rich content payloads with invoked skills', () => {
    const payload = {
      content: 'do the thing',
      invokedSkills: ['demo-skill'],
    }
    assert.deepEqual(parseAgentRunPayload(JSON.stringify(payload)), {
      userContent: 'do the thing',
      invokedSkills: ['demo-skill'],
      priorTodos: [],
    })
  })

  it('parses prior todos from payload', () => {
    const payload = {
      content: 'continue',
      priorTodos: [{ id: 't1', content: 'Step one', status: 'completed' as const }],
    }
    const r = parseAgentRunPayload(JSON.stringify(payload))
    assert.equal(r.priorTodos.length, 1)
    assert.equal(r.priorTodos[0]?.content, 'Step one')
  })

  it('parses workingBrief from payload', () => {
    const payload = {
      content: 'follow up',
      workingBrief: 'refactor authentication',
    }
    const r = parseAgentRunPayload(JSON.stringify(payload))
    assert.equal(r.workingBrief, 'refactor authentication')
  })

  it('parses a per-thread model override from payload', () => {
    const r = parseAgentRunPayload(JSON.stringify({ content: 'hi', model: 'claude-opus-4-8' }))
    assert.equal(r.model, 'claude-opus-4-8')
  })

  it('omits model when absent or empty so main falls back to the global default', () => {
    assert.equal('model' in parseAgentRunPayload(JSON.stringify({ content: 'hi' })), false)
    assert.equal(
      'model' in parseAgentRunPayload(JSON.stringify({ content: 'hi', model: '' })),
      false,
    )
  })

  it('parses the turn-tree epoch + spent continuation budget (C3 / decision 5)', () => {
    const r = parseAgentRunPayload(
      JSON.stringify({ content: 'go', turnTreeId: 'tree-1', continuationBudgetUsed: 3 }),
    )
    assert.equal(r.turnTreeId, 'tree-1')
    assert.equal(r.continuationBudgetUsed, 3)
  })

  it('omits the turn-tree fields when absent or invalid', () => {
    const bare = parseAgentRunPayload(JSON.stringify({ content: 'go' }))
    assert.equal('turnTreeId' in bare, false)
    assert.equal('continuationBudgetUsed' in bare, false)
    // An empty epoch / non-finite count is dropped rather than threaded through.
    const bad = parseAgentRunPayload(
      JSON.stringify({ content: 'go', turnTreeId: '', continuationBudgetUsed: Number.NaN }),
    )
    assert.equal('turnTreeId' in bad, false)
    assert.equal('continuationBudgetUsed' in bad, false)
  })

  it('carries the summary of reviews the user ran, and drops a blank or non-string one', () => {
    const r = parseAgentRunPayload(
      JSON.stringify({ content: 'fix it', reviewContext: '<copse_review_report>…' }),
    )
    assert.equal(r.reviewContext, '<copse_review_report>…')
    for (const reviewContext of ['  ', 42, null]) {
      const bad = parseAgentRunPayload(JSON.stringify({ content: 'fix it', reviewContext }))
      assert.equal(Object.hasOwn(bad, 'reviewContext'), false)
    }
  })

  it('caps an oversized review summary so one prompt cannot flood the history', () => {
    const r = parseAgentRunPayload(
      JSON.stringify({
        content: 'fix it',
        reviewContext: 'x'.repeat(REVIEW_CONTEXT_CHAR_CAP + 50),
      }),
    )
    assert.ok(r.reviewContext)
    assert.ok(r.reviewContext.length < REVIEW_CONTEXT_CHAR_CAP + 50)
    assert.ok(r.reviewContext.endsWith('[review summary truncated]'))
  })
})
