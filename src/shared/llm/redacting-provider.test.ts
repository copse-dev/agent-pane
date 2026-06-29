import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMProvider, LLMMessage, LLMTool, StreamChunk } from '@shared/types'
import { withSecretRedaction } from './redacting-provider.ts'
import { REDACTED_PLACEHOLDER } from './redact-secrets.ts'

function fakeProvider(): {
  provider: LLMProvider & { lastUsage: unknown }
  seen: { messages: LLMMessage[] | null }
} {
  const seen: { messages: LLMMessage[] | null } = { messages: null }
  const provider: LLMProvider & { lastUsage: unknown } = {
    lastUsage: { inputTokens: 7, outputTokens: 3 },
    stream(
      messages: LLMMessage[],
      _tools: LLMTool[],
      _signal?: AbortSignal,
    ): AsyncIterable<StreamChunk> {
      seen.messages = messages
      return (async function* () {
        yield { type: 'done' } as StreamChunk
      })()
    },
  }
  return { provider, seen }
}

describe('withSecretRedaction', () => {
  it('redacts secrets from messages before they reach the inner provider', async () => {
    const token = `ghp_${'a'.repeat(40)}`
    const { provider, seen } = fakeProvider()
    const wrapped = withSecretRedaction(provider, ['my-configured-key-123456'])

    const messages: LLMMessage[] = [
      { role: 'user', content: `here is ${token} and my-configured-key-123456` },
    ]
    // Drain the stream so `stream` actually runs.
    for await (const _ of wrapped.stream(messages, [])) void _

    assert.ok(seen.messages, 'inner provider should have been called')
    const sent = JSON.stringify(seen.messages)
    assert.ok(!sent.includes(token))
    assert.ok(!sent.includes('my-configured-key-123456'))
    assert.ok(sent.includes(REDACTED_PLACEHOLDER))
    // Original messages must not be mutated.
    assert.ok(JSON.stringify(messages).includes(token))
  })

  it('exposes the inner provider lastUsage', () => {
    const { provider } = fakeProvider()
    const wrapped = withSecretRedaction(provider) as LLMProvider & { lastUsage: unknown }
    assert.deepEqual(wrapped.lastUsage, { inputTokens: 7, outputTokens: 3 })
  })
})
