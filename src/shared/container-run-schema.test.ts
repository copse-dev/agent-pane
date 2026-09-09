import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { containerRunRequestSchema, threadContainerResultSchema } from './container-run-schema.ts'

describe('container wire contracts', () => {
  const request = {
    projectId: 'project',
    threadId: 'thread',
    prompt: 'Do the work',
    model: 'model',
    budgets: { wallClockMs: 60_000, tokenCeiling: 1_000 },
  }
  it('preserves continuation data and optional run settings', () => {
    const input = {
      ...request,
      useAgentLogin: true,
      installDependencies: true,
      extraEgress: ['*.example.com:443'],
      continueFrom: 'run-123',
      continueContext: {
        prompt: 'previous prompt',
        report: 'previous report',
        ref: 'refs/copse/runs/run-123',
      },
    }
    assert.deepEqual(containerRunRequestSchema.parse(input), input)
    assert.deepEqual(containerRunRequestSchema.parse(request), request)
  })
  it('retains the IPC limits and rejects arbitrary continuation refs', () => {
    for (const input of [
      { ...request, budgets: { ...request.budgets, wallClockMs: 59_999 } },
      { ...request, extraEgress: ['https://example.com'] },
      { ...request, continueContext: { prompt: '', report: '', ref: 'refs/heads/main' } },
    ])
      assert.equal(containerRunRequestSchema.safeParse(input).success, false)
  })
  it('rejects incomplete results and unknown stop reasons', () => {
    assert.equal(threadContainerResultSchema.safeParse({ threadId: 'thread' }).success, false)
    assert.equal(threadContainerResultSchema.shape.stopReason.safeParse('success').success, false)
  })
})
