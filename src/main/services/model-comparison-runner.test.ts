import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setApprovalHandler } from './approval.ts'
import { runModelComparison } from './model-comparison-runner.ts'
import { storageDelete, storageSet } from './storage/storage.ts'
import { ToolRegistry } from './tool-registry.ts'

const COMPARISON_SETTINGS_KEY = 'plugin.copse.model-comparison.settings'

describe('runModelComparison approval cancellation', () => {
  afterEach(() => {
    setApprovalHandler(null)
    storageDelete(COMPARISON_SETTINGS_KEY)
  })

  it('dismisses a pending spend approval when the run aborts', { timeout: 500 }, async () => {
    storageSet(COMPARISON_SETTINGS_KEY, {
      comparisonModelA: 'gpt-5',
      comparisonModelB: 'claude-sonnet-4-6',
      comparisonJudgeModel: 'gpt-4o',
    })
    let handlerSignal: AbortSignal | undefined
    let markPrompted!: () => void
    const prompted = new Promise<void>((resolve) => {
      markPrompted = resolve
    })
    setApprovalHandler(
      (_request, approvalSignal) =>
        new Promise(() => {
          handlerSignal = approvalSignal
          markPrompted()
        }),
    )
    const controller = new AbortController()
    const pending = runModelComparison(
      {
        threadId: 'comparison-cancel-thread',
        parentGoal: 'Review the current diff',
        registry: new ToolRegistry(),
        chatModel: 'gpt-5',
        onChunk: () => undefined,
      },
      controller.signal,
    )
    await prompted

    controller.abort()

    const result = await pending
    assert.equal(result.comparison?.status, 'error')
    assert.equal(result.comparison.error, 'Comparison cancelled.')
    assert.equal(handlerSignal?.aborted, true)
  })
})
