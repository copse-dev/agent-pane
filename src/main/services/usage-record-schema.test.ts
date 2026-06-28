import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseUsageRecordInput } from './usage-record-schema.ts'

describe('usage record schema', () => {
  it('accepts agent usage with optional cache and context ids', () => {
    const parsed = parseUsageRecordInput({
      model: 'claude-sonnet-4-6',
      source: 'agent',
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 50,
      projectId: 'proj-1',
      threadId: 'thread-1',
    })
    assert.equal(parsed.model, 'claude-sonnet-4-6')
    assert.equal(parsed.cacheReadTokens, 50)
  })

  it('rejects unknown sources', () => {
    assert.throws(() =>
      parseUsageRecordInput({
        model: 'gpt-4o',
        source: 'unknown',
        inputTokens: 1,
        outputTokens: 1,
      }),
    )
  })
})
