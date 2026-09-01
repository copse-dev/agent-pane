import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMProvider } from '@shared/types'
import { completeMessagesWithUsage } from './llm-complete-text.ts'

describe('completeMessagesWithUsage', () => {
  it('aborts the provider stream when the caller aborts', { timeout: 500 }, async () => {
    let providerSignal: AbortSignal | undefined
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const provider: LLMProvider = {
      async *stream(_messages, _tools, signal) {
        providerSignal = signal
        markStarted()
        await new Promise<void>((resolve) => {
          signal?.addEventListener(
            'abort',
            () => {
              resolve()
            },
            { once: true },
          )
        })
        yield { type: 'done' }
      },
    }
    const controller = new AbortController()
    const pending = completeMessagesWithUsage(provider, [], 60_000, controller.signal)
    await started

    controller.abort()

    assert.deepEqual(await pending, {
      text: '',
      usage: { inputTokens: 0, outputTokens: 0 },
    })
    assert.equal(providerSignal?.aborted, true)
  })
})
