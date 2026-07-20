import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { usageRecordFromAgentDelta } from './usage-record-input.ts'

describe('usageRecordFromAgentDelta', () => {
  it('defaults ledger source to agent', () => {
    const record = usageRecordFromAgentDelta(
      'thread-1',
      { model: 'claude-sonnet-4-6', inputTokens: 10, outputTokens: 2 },
      'proj-1',
    )
    assert.equal(record.source, 'agent')
  })

  it('propagates usageSource advisor so main+renderer dual-writes dedupe', () => {
    const record = usageRecordFromAgentDelta(
      'thread-1',
      {
        model: 'claude-opus-4-8',
        inputTokens: 900,
        outputTokens: 40,
        usageSource: 'advisor',
      },
      'proj-1',
    )
    assert.equal(record.source, 'advisor')
    assert.equal(record.model, 'claude-opus-4-8')
  })
})
