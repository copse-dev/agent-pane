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

  it(
    'reports the deadline even when the provider ends the stream cleanly on abort',
    { timeout: 500 },
    async () => {
      // The native LM Studio client answers a cancel with a normal completion
      // carrying the partial text, so without this the timeout would pass for a
      // fast, finished answer.
      const provider: LLMProvider = {
        async *stream(_messages, _tools, signal) {
          yield { type: 'text', text: '{"risk":' }
          await new Promise<void>((resolve) => {
            signal?.addEventListener(
              'abort',
              () => {
                resolve()
              },
              { once: true },
            )
          })
          yield { type: 'done', stopReason: 'user_stopped' }
        },
      }

      await assert.rejects(completeMessagesWithUsage(provider, [], 20), (err: unknown) => {
        assert.ok(err instanceof DOMException)
        assert.equal(err.name, 'TimeoutError')
        return true
      })
    },
  )

  it(
    'still returns the partial text when the caller, not the timer, aborted',
    { timeout: 500 },
    async () => {
      const provider: LLMProvider = {
        async *stream(_messages, _tools, signal) {
          yield { type: 'text', text: 'partial' }
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
      await new Promise((resolve) => setTimeout(resolve, 5))
      controller.abort()

      assert.equal((await pending).text, 'partial')
    },
  )
})
