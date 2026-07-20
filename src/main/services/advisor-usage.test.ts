import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { StreamChunk } from '@shared/types'
import { emitAdvisorUsage } from './advisor-usage.ts'

describe('emitAdvisorUsage', () => {
  it('emits a usage chunk on the advisor model with usageSource advisor', () => {
    const chunks: StreamChunk[] = []
    emitAdvisorUsage((chunk) => chunks.push(chunk), 'claude-opus-4-8', {
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadTokens: 400,
    })
    assert.deepEqual(chunks, [
      {
        type: 'usage',
        model: 'claude-opus-4-8',
        inputTokens: 1200,
        outputTokens: 80,
        usageSource: 'advisor',
        cacheReadTokens: 400,
      },
    ])
  })

  it('skips empty usage so zero-token advisor stubs do not pollute the ledger', () => {
    const chunks: StreamChunk[] = []
    emitAdvisorUsage((chunk) => chunks.push(chunk), 'claude-opus-4-8', {
      inputTokens: 0,
      outputTokens: 0,
    })
    assert.deepEqual(chunks, [])
  })
})
