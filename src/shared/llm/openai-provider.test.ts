import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIProvider } from './openai-provider.ts'

interface CapturedChatCompletionRequest {
  model: string
  stream?: boolean
  stream_options?: { include_usage?: boolean }
}

interface ChatCompletionChunk {
  choices: Array<{
    delta?: { content?: string }
    finish_reason?: string | null
  }>
}

interface OpenAIProviderForTest {
  client: {
    chat: {
      completions: {
        create: (
          request: CapturedChatCompletionRequest,
          opts?: unknown,
        ) => AsyncIterable<ChatCompletionChunk>
      }
    }
  }
}

async function* oneTextChunk(): AsyncIterable<ChatCompletionChunk> {
  yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }
}

async function collect(provider: OpenAIProvider): Promise<void> {
  for await (const _chunk of provider.stream([], [])) {
    // Drain the stream so chat.completions.create is invoked.
  }
}

describe('OpenAIProvider request options', () => {
  it('asks OpenAI cloud streams to include usage', async () => {
    const provider = new OpenAIProvider('gpt-test', { apiKey: 'test-openai-key' })
    let captured: CapturedChatCompletionRequest | null = null
    ;(provider as unknown as OpenAIProviderForTest).client.chat.completions.create = (request) => {
      captured = request
      return oneTextChunk()
    }

    await collect(provider)

    assert.equal(captured?.stream_options?.include_usage, true)
  })

  it('omits stream_options for custom base URLs by default', async () => {
    const provider = new OpenAIProvider('local-model', {
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'local-key',
    })
    let captured: CapturedChatCompletionRequest | null = null
    ;(provider as unknown as OpenAIProviderForTest).client.chat.completions.create = (request) => {
      captured = request
      return oneTextChunk()
    }

    await collect(provider)

    assert.equal(captured?.stream_options, undefined)
  })
})
