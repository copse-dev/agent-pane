import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolCallRequestError, type Chat, type LLMRespondOpts } from '@lmstudio/sdk'
import { LMStudioProvider, lmStudioWebSocketUrl } from './lm-studio-provider.ts'
import type { LLMMessage, LLMTool, ProviderStreamChunk } from './wire-types.ts'

class FakePrediction {
  private readonly opts: LLMRespondOpts

  constructor(opts: LLMRespondOpts) {
    this.opts = opts
  }

  async result(): Promise<{
    stats: {
      stopReason: 'toolCalls'
      promptTokensCount: number
      predictedTokensCount: number
    }
  }> {
    this.opts.onPromptProcessingProgress?.(0.47)
    this.opts.onPredictionFragment?.({
      content: 'considering',
      tokensCount: 1,
      containsDrafted: false,
      reasoningType: 'reasoning',
      isStructural: false,
    })
    this.opts.onPredictionFragment?.({
      content: 'hello',
      tokensCount: 1,
      containsDrafted: false,
      reasoningType: 'none',
      isStructural: false,
    })
    this.opts.onToolCallRequestEnd?.(7, {
      toolCallRequest: {
        id: 'call-7',
        type: 'function',
        name: 'list_dir',
        arguments: { path: '.' },
      },
      rawContent: undefined,
    })
    return {
      stats: {
        stopReason: 'toolCalls',
        promptTokensCount: 123,
        predictedTokensCount: 9,
      },
    }
  }
}

class FakeModel {
  chat: Chat | null = null
  opts: LLMRespondOpts | null = null

  respond(chat: Chat, opts: LLMRespondOpts): FakePrediction {
    this.chat = chat
    this.opts = opts
    return new FakePrediction(opts)
  }
}

/**
 * Reports an unparseable tool call the way the SDK does — through a callback,
 * while the prediction keeps running — and settles only once it is cancelled.
 */
class FakeToolFailureModel {
  opts: LLMRespondOpts | null = null

  respond(_chat: Chat, opts: LLMRespondOpts): { result: () => Promise<never> } {
    this.opts = opts
    return {
      result: (): Promise<never> =>
        new Promise<never>((_resolve, reject) => {
          opts.onToolCallRequestFailure?.(1, new ToolCallRequestError('bad tool call', '{['))
          opts.signal?.addEventListener(
            'abort',
            (): void => {
              reject(new Error('prediction cancelled'))
            },
            { once: true },
          )
        }),
    }
  }
}

class FakeToolFailureClient {
  readonly modelHandle = new FakeToolFailureModel()

  model(): Promise<FakeToolFailureModel> {
    return Promise.resolve(this.modelHandle)
  }

  prepareImageBase64(): Promise<never> {
    return Promise.reject(new Error('unexpected image'))
  }
}

class FakeClient {
  readonly modelHandle = new FakeModel()

  model(): Promise<FakeModel> {
    return Promise.resolve(this.modelHandle)
  }

  prepareImageBase64(): Promise<never> {
    return Promise.reject(new Error('unexpected image'))
  }
}

describe('LMStudioProvider tuned parameters', () => {
  it('maps sampling knobs and the published output ceiling onto the SDK config', async () => {
    const client = new FakeClient()
    // qwen3.6-35b-a3b's card publishes an unconditional 81,920-token ceiling
    // (see model-parameters.ts); the OpenAI-compatible transport sent it as
    // max_tokens, and the native transport must keep doing so or long answers
    // get truncated by the server default.
    const provider = new LMStudioProvider('qwen/qwen3.6-35b-a3b', {
      client,
      params: {
        temperature: 1,
        topP: 0.95,
        topK: 20,
        minP: 0,
        repetitionPenalty: 1,
      },
    })
    const messages: LLMMessage[] = [{ role: 'user', content: 'hello' }]
    for await (const _ of provider.stream(messages, [])) void _
    const opts = client.modelHandle.opts
    assert.ok(opts)
    assert.equal(opts['temperature'], 1)
    assert.equal(opts['topPSampling'], 0.95)
    assert.equal(opts['topKSampling'], 20)
    assert.equal(opts['minPSampling'], 0)
    assert.equal(opts['repeatPenalty'], 1)
    assert.equal(opts['maxTokens'], 81_920)
  })

  it('sends no ceiling when the model card publishes none', async () => {
    const client = new FakeClient()
    const provider = new LMStudioProvider('some-uncatalogued-model', { client })
    const messages: LLMMessage[] = [{ role: 'user', content: 'hello' }]
    for await (const _ of provider.stream(messages, [])) void _
    const opts = client.modelHandle.opts
    assert.ok(opts)
    assert.equal(opts['maxTokens'], undefined)
  })
})

async function collect(provider: LMStudioProvider): Promise<ProviderStreamChunk[]> {
  const chunks: ProviderStreamChunk[] = []
  const messages: LLMMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: [{ id: 'prior-call', name: 'read_file', args: { path: 'README.md' } }],
    },
    { role: 'tool', toolResults: [{ toolCallId: 'prior-call', result: 'contents' }] },
  ]
  const tools: LLMTool[] = [
    {
      name: 'list_dir',
      description: 'List a directory',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  ]
  for await (const chunk of provider.stream(messages, tools)) chunks.push(chunk)
  return chunks
}

describe('LMStudioProvider', () => {
  it('maps native progress, reasoning, text, tool calls, usage, and completion', async () => {
    const client = new FakeClient()
    const provider = new LMStudioProvider('local-model', { client })

    assert.deepEqual(await collect(provider), [
      { type: 'prompt_progress', fraction: 0.47 },
      { type: 'reasoning', text: 'considering' },
      { type: 'text', text: 'hello' },
      {
        type: 'tool_call',
        toolCall: { id: 'call-7', name: 'list_dir', args: { path: '.' } },
      },
      { type: 'usage', model: 'local-model', inputTokens: 123, outputTokens: 9 },
      { type: 'done', stopReason: 'tool_calls' },
    ])
    assert.deepEqual(provider.lastUsage, { inputTokens: 123, outputTokens: 9 })

    const rawTools = Reflect.get(client.modelHandle.opts ?? {}, 'rawTools')
    assert.deepEqual(rawTools, {
      type: 'toolArray',
      tools: [
        {
          type: 'function',
          function: {
            name: 'list_dir',
            description: 'List a directory',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        },
      ],
    })
    assert.deepEqual(
      client.modelHandle.chat?.getMessagesArray().map((message) => ({
        role: message.getRole(),
        text: message.getText(),
        toolCalls: message.getToolCallRequests(),
        toolResults: message.getToolCallResults(),
      })),
      [
        { role: 'system', text: 'system', toolCalls: [], toolResults: [] },
        { role: 'user', text: 'hello', toolCalls: [], toolResults: [] },
        {
          role: 'assistant',
          text: '',
          toolCalls: [
            {
              id: 'prior-call',
              type: 'function',
              name: 'read_file',
              arguments: { path: 'README.md' },
            },
          ],
          toolResults: [],
        },
        {
          role: 'tool',
          text: '',
          toolCalls: [],
          toolResults: [{ toolCallId: 'prior-call', content: 'contents' }],
        },
      ],
    )
  })

  it('cancels the prediction when the model emits an unparseable tool call', async () => {
    // The SDK reports the bad tool call through a callback and keeps predicting
    // until it is cancelled, so failing our queue alone would leave the local
    // model generating tokens no one can read.
    const client = new FakeToolFailureClient()
    const provider = new LMStudioProvider('local-model', { client })

    await assert.rejects(
      async () => {
        for await (const _ of provider.stream([{ role: 'user', content: 'hello' }], [])) void _
      },
      // The parse failure surfaces to the caller rather than being retried:
      // replaying the same prompt would produce the same broken tool call.
      /bad tool call/,
    )
    assert.equal(client.modelHandle.opts?.signal?.aborted, true)
  })

  it('converts the configured OpenAI endpoint into the SDK WebSocket origin', () => {
    assert.equal(lmStudioWebSocketUrl('http://localhost:1234/v1'), 'ws://localhost:1234')
    assert.equal(
      lmStudioWebSocketUrl('https://models.example.test/v1/'),
      'wss://models.example.test',
    )
    assert.throws(() => lmStudioWebSocketUrl('ftp://localhost/model'), /Unsupported/)
  })
})
