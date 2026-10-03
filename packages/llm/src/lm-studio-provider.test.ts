import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolCallRequestError, type Chat, type LLMRespondOpts } from '@lmstudio/sdk'
import { LMStudioProvider, lmStudioWebSocketUrl } from './lm-studio-provider.ts'
import type { LLMMessage, LLMTool, ProviderStreamChunk } from './wire-types.ts'

class FakePrediction {
  private readonly opts: LLMRespondOpts
  private readonly toolCallId: string | null

  constructor(opts: LLMRespondOpts, toolCallId: string | null) {
    this.opts = opts
    this.toolCallId = toolCallId
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
    // The SDK's `callId` is a per-prediction counter, so the first tool call
    // of every prediction reports 0 whatever the server called it.
    this.opts.onToolCallRequestEnd?.(0, {
      toolCallRequest: {
        ...(this.toolCallId === null ? {} : { id: this.toolCallId }),
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
  private readonly toolCallId: string | null

  constructor(toolCallId: string | null) {
    this.toolCallId = toolCallId
  }

  respond(chat: Chat, opts: LLMRespondOpts): FakePrediction {
    this.chat = chat
    this.opts = opts
    return new FakePrediction(opts, this.toolCallId)
  }
}

/**
 * Reports an unparseable tool call the way the SDK does — through a callback,
 * while the prediction keeps running — and settles only once it is cancelled.
 */
class FakeToolFailureModel {
  opts: LLMRespondOpts | null = null
  private readonly tokensBeforeFailure: number

  constructor(tokensBeforeFailure: number) {
    this.tokensBeforeFailure = tokensBeforeFailure
  }

  respond(_chat: Chat, opts: LLMRespondOpts): { result: () => Promise<never> } {
    this.opts = opts
    return {
      result: (): Promise<never> =>
        new Promise<never>((_resolve, reject) => {
          if (this.tokensBeforeFailure > 0) {
            opts.onPredictionFragment?.({
              content: 'x',
              tokensCount: this.tokensBeforeFailure,
              containsDrafted: false,
              reasoningType: 'none',
              isStructural: false,
            })
          }
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

/** Streams one fragment, then keeps predicting until it is cancelled. */
class FakeEndlessModel {
  opts: LLMRespondOpts | null = null

  respond(_chat: Chat, opts: LLMRespondOpts): { result: () => Promise<never> } {
    this.opts = opts
    return {
      result: (): Promise<never> =>
        new Promise<never>((_resolve, reject) => {
          opts.onPredictionFragment?.({
            content: 'thinking',
            tokensCount: 1,
            containsDrafted: false,
            reasoningType: 'reasoning',
            isStructural: false,
          })
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

class FakeEndlessClient {
  readonly modelHandle = new FakeEndlessModel()

  model(): Promise<FakeEndlessModel> {
    return Promise.resolve(this.modelHandle)
  }

  prepareImageBase64(): Promise<never> {
    return Promise.reject(new Error('unexpected image'))
  }
}

class FakeToolFailureClient {
  readonly modelHandle: FakeToolFailureModel

  constructor(opts: { tokensBeforeFailure?: number } = {}) {
    this.modelHandle = new FakeToolFailureModel(opts.tokensBeforeFailure ?? 0)
  }

  model(): Promise<FakeToolFailureModel> {
    return Promise.resolve(this.modelHandle)
  }

  prepareImageBase64(): Promise<never> {
    return Promise.reject(new Error('unexpected image'))
  }
}

class FakeClient {
  readonly modelHandle: FakeModel

  /** `toolCallId` is the id the server reports; `null` omits it. */
  constructor(toolCallId: string | null = 'call-7') {
    this.modelHandle = new FakeModel(toolCallId)
  }

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
    for await (const _ of provider.stream(messages, [])) {
      // Drain the stream so the provider sends and captures the request.
    }
    const opts = client.modelHandle.opts
    assert.ok(opts)
    assert.equal(opts['temperature'], 1)
    assert.equal(opts['topPSampling'], 0.95)
    assert.equal(opts['topKSampling'], 20)
    assert.equal(opts['minPSampling'], 0)
    assert.equal(opts['repeatPenalty'], 1)
    assert.equal(opts['maxTokens'], 81_920)
  })

  it('sends the user-set output cap in place of the card ceiling', async () => {
    const client = new FakeClient()
    const provider = new LMStudioProvider('qwen/qwen3.6-35b-a3b', {
      client,
      params: { maxOutputTokens: 4_096 },
    })
    const messages: LLMMessage[] = [{ role: 'user', content: 'hello' }]
    for await (const _ of provider.stream(messages, [])) {
      // Drain the stream so the provider sends and captures the request.
    }
    const opts = client.modelHandle.opts
    assert.ok(opts)
    assert.equal(opts['maxTokens'], 4_096)
  })

  it('sends no ceiling when the model card publishes none', async () => {
    const client = new FakeClient()
    const provider = new LMStudioProvider('some-uncatalogued-model', { client })
    const messages: LLMMessage[] = [{ role: 'user', content: 'hello' }]
    for await (const _ of provider.stream(messages, [])) {
      // Drain the stream so the provider sends and captures the request.
    }
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

  it('gives each id-less tool call a unique id across predictions', async () => {
    // Falling back to the SDK's per-prediction `callId` named the first call of
    // every turn `lmstudio-0`; the thread store keys tool-result blobs by id, so
    // the second turn overwrote the first turn's result and the thread stopped
    // loading.
    const provider = new LMStudioProvider('local-model', { client: new FakeClient(null) })
    const toolCallIds = async (): Promise<string[]> =>
      (await collect(provider)).flatMap((chunk) =>
        chunk.type === 'tool_call' ? [chunk.toolCall.id] : [],
      )
    const [first] = await toolCallIds()
    const [second] = await toolCallIds()
    assert.ok(first && second)
    assert.match(first, /^tc_/)
    assert.notEqual(first, second)
  })

  it('ends the stream with a typed outcome and cancels the prediction on an unparseable tool call', async () => {
    // The SDK reports the bad tool call through a callback and keeps predicting
    // until it is cancelled, so ending our queue alone would leave the local
    // model generating tokens no one can read. The stream must end normally
    // (not throw) so the agent loop can recover instead of the run dying.
    const client = new FakeToolFailureClient()
    const provider = new LMStudioProvider('local-model', { client })

    const chunks: ProviderStreamChunk[] = []
    for await (const chunk of provider.stream([{ role: 'user', content: 'hello' }], [])) {
      chunks.push(chunk)
    }

    assert.deepEqual(chunks.at(-1), {
      type: 'done',
      stopReason: 'tool_call_malformed',
      malformedToolCall: { message: 'bad tool call', hitOutputCeiling: false },
    })
    assert.equal(client.modelHandle.opts?.signal?.aborted, true)
  })

  it('reports that the output ceiling cut off the tool call when the streamed tokens reach it', async () => {
    const client = new FakeToolFailureClient({ tokensBeforeFailure: 16_000 })
    const provider = new LMStudioProvider('local-model', {
      client,
      params: { maxOutputTokens: 16_384 },
    })

    const chunks: ProviderStreamChunk[] = []
    for await (const chunk of provider.stream([{ role: 'user', content: 'hello' }], [])) {
      chunks.push(chunk)
    }

    assert.deepEqual(chunks.at(-1), {
      type: 'done',
      stopReason: 'tool_call_malformed',
      malformedToolCall: { message: 'bad tool call', hitOutputCeiling: true, outputTokens: 16_000 },
    })
  })

  it('cancels the prediction when the consumer stops reading early', async () => {
    // The agent loop breaks out of a stream it cut for runaway reasoning. LM
    // Studio keeps predicting up to its output ceiling unless it is cancelled,
    // and the next request then waits behind that abandoned prediction.
    const client = new FakeEndlessClient()
    const provider = new LMStudioProvider('local-model', { client })

    for await (const chunk of provider.stream([{ role: 'user', content: 'hello' }], [])) {
      if (chunk.type === 'reasoning') break
    }

    assert.equal(client.modelHandle.opts?.signal?.aborted, true)
  })

  it('does not cancel a prediction that the consumer reads to the end', async () => {
    const client = new FakeClient()
    const provider = new LMStudioProvider('local-model', { client })

    for await (const _ of provider.stream([{ role: 'user', content: 'hello' }], [])) {
      // Drain to completion.
    }

    assert.equal(client.modelHandle.opts?.signal?.aborted, false)
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
