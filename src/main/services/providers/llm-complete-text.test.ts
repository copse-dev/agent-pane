import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMProvider } from '@shared/types'
import type { ProviderWithUsage } from '@copse/llm/provider-usage.ts'
import { completeMessagesWithUsage } from './llm-complete-text.ts'

describe('completeMessagesWithUsage', () => {
  it('retains mixed tier buckets while accumulating provider usage chunks', async () => {
    const provider: LLMProvider = {
      async *stream() {
        yield {
          type: 'usage' as const,
          model: 'gpt-4o',
          inputTokens: 100,
          outputTokens: 10,
          requestedServiceTier: 'flex' as const,
        }
        yield {
          type: 'usage' as const,
          model: 'gpt-4o',
          inputTokens: 200,
          outputTokens: 20,
          requestedServiceTier: 'flex' as const,
          responseServiceTier: 'priority' as const,
        }
        yield { type: 'done' as const }
      },
    }

    const result = await completeMessagesWithUsage(provider, [], 60_000)
    assert.deepEqual(result.usage, {
      inputTokens: 300,
      outputTokens: 30,
      serviceTierUsage: {
        flex: { inputTokens: 100, outputTokens: 10 },
        priority: { inputTokens: 200, outputTokens: 20 },
      },
    })
  })

  it('keeps provider.lastUsage as the standard fallback when no chunk has usage', async () => {
    const provider: LLMProvider & ProviderWithUsage = {
      lastUsage: { inputTokens: 100, outputTokens: 10 },
      async *stream() {
        yield { type: 'done' as const }
      },
    }
    const result = await completeMessagesWithUsage(provider, [], 60_000)
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 10 })
  })

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
