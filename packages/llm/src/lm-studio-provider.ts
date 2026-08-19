import {
  Chat,
  LMStudioClient,
  type FileHandle,
  type FunctionToolCallRequest,
  type LLM as LMStudioModel,
  type LLMPredictionFragment,
  type LLMRespondOpts,
  type LLMTool as LMStudioTool,
  type OngoingPrediction,
  type PredictionResult,
} from '@lmstudio/sdk'
import { yieldStreamWithRetry } from './stream-retry.ts'
import type { LLMMessage, LLMProvider, LLMTool, ProviderStreamChunk } from './wire-types.ts'

type RespondOptions = Pick<
  LLMRespondOpts,
  | 'rawTools'
  | 'signal'
  | 'onPredictionFragment'
  | 'onPromptProcessingProgress'
  | 'onToolCallRequestEnd'
  | 'onToolCallRequestFailure'
>

interface PredictionAdapter {
  result(): Promise<Pick<PredictionResult, 'stats'>>
}

interface ModelAdapter {
  respond(chat: Chat, opts: RespondOptions): PredictionAdapter
}

interface ClientAdapter {
  model(identifier: string): Promise<ModelAdapter>
  prepareImageBase64(fileName: string, contentBase64: string): Promise<FileHandle>
}

class SdkModelAdapter implements ModelAdapter {
  private readonly modelHandle: LMStudioModel

  constructor(modelHandle: LMStudioModel) {
    this.modelHandle = modelHandle
  }

  respond(chat: Chat, opts: RespondOptions): Pick<OngoingPrediction, 'result'> {
    return this.modelHandle.respond(chat, opts)
  }
}

class SdkClientAdapter implements ClientAdapter {
  private readonly client: LMStudioClient

  constructor(openAiBaseUrl: string) {
    this.client = new LMStudioClient({ baseUrl: lmStudioWebSocketUrl(openAiBaseUrl) })
  }

  async model(identifier: string): Promise<ModelAdapter> {
    return new SdkModelAdapter(await this.client.llm.model(identifier))
  }

  prepareImageBase64(fileName: string, contentBase64: string): Promise<FileHandle> {
    return this.client.files.prepareImageBase64(fileName, contentBase64)
  }
}

interface QueueWaiter<T> {
  resolve: (result: IteratorResult<T>) => void
  reject: (error: unknown) => void
}

/** Single-consumer async queue used to bridge the SDK's callbacks into our provider stream. */
class AsyncChunkQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = []
  private waiter: QueueWaiter<T> | null = null
  private ended = false
  private failure: Error | null = null

  push(value: T): void {
    if (this.ended) return
    const waiter = this.waiter
    if (waiter) {
      this.waiter = null
      waiter.resolve({ value, done: false })
      return
    }
    this.values.push(value)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    const waiter = this.waiter
    if (waiter) {
      this.waiter = null
      waiter.resolve({ value: undefined, done: true })
    }
  }

  fail(error: unknown): void {
    if (this.ended) return
    const failure = error instanceof Error ? error : new Error(String(error))
    this.failure = failure
    this.ended = true
    const waiter = this.waiter
    if (waiter) {
      this.waiter = null
      waiter.reject(failure)
    }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ value, done: false })
    if (this.failure !== null) return Promise.reject(this.failure)
    if (this.ended) return Promise.resolve({ value: undefined, done: true })
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this
  }
}

export interface LMStudioProviderOptions {
  baseURL?: string
  /** Test seam: production callers use the official SDK adapter. */
  client?: ClientAdapter
}

/**
 * LM Studio's SDK transport, used instead of its OpenAI-compatible endpoint so
 * prompt-processing progress can reach the UI. Raw tool definitions keep tool
 * execution in Copse's permission-controlled agent loop; the SDK never runs a
 * tool implementation itself.
 */
export class LMStudioProvider implements LLMProvider {
  lastUsage: { inputTokens: number; outputTokens: number } | null = null
  private readonly client: ClientAdapter
  private readonly modelName: string

  constructor(modelName: string, opts: LMStudioProviderOptions = {}) {
    this.modelName = modelName
    this.client = opts.client ?? new SdkClientAdapter(opts.baseURL ?? 'http://localhost:1234/v1')
  }

  stream(
    messages: LLMMessage[],
    tools: LLMTool[],
    signal?: AbortSignal,
  ): AsyncIterable<ProviderStreamChunk> {
    const self = this
    return yieldStreamWithRetry(
      async function* () {
        yield* self.streamOnce(messages, tools, signal)
      },
      { ...(signal ? { signal } : {}) },
    )
  }

  private async *streamOnce(
    messages: LLMMessage[],
    tools: LLMTool[],
    signal?: AbortSignal,
  ): AsyncIterable<ProviderStreamChunk> {
    const queue = new AsyncChunkQueue<ProviderStreamChunk>()
    void this.produce(messages, tools, signal, queue)
    yield* queue
  }

  private async produce(
    messages: LLMMessage[],
    tools: LLMTool[],
    signal: AbortSignal | undefined,
    queue: AsyncChunkQueue<ProviderStreamChunk>,
  ): Promise<void> {
    try {
      const [model, chat] = await Promise.all([
        this.client.model(this.modelName),
        toLmStudioChat(messages, this.client),
      ])
      const rawTools = toLmStudioTools(tools)
      const prediction = model.respond(chat, {
        rawTools: rawTools.length ? { type: 'toolArray', tools: rawTools } : { type: 'none' },
        ...(signal ? { signal } : {}),
        onPromptProcessingProgress: (progress) => {
          queue.push({ type: 'prompt_progress', fraction: clampProgress(progress) })
        },
        onPredictionFragment: (fragment) => {
          const chunk = chunkFromPredictionFragment(fragment)
          if (chunk) queue.push(chunk)
        },
        onToolCallRequestEnd: (callId, { toolCallRequest }) => {
          queue.push(toolCallChunk(callId, toolCallRequest))
        },
        onToolCallRequestFailure: (_callId, error) => {
          queue.fail(error)
        },
      })
      const result = await prediction.result()
      const inputTokens = result.stats.promptTokensCount ?? 0
      const outputTokens = result.stats.predictedTokensCount ?? 0
      this.lastUsage = { inputTokens, outputTokens }
      if (inputTokens || outputTokens) {
        queue.push({ type: 'usage', model: this.modelName, inputTokens, outputTokens })
      }
      queue.push({ type: 'done', stopReason: mapStopReason(result.stats.stopReason) })
      queue.end()
    } catch (error) {
      queue.fail(error)
    }
  }
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0
  return Math.min(1, Math.max(0, progress))
}

function chunkFromPredictionFragment(
  fragment: LLMPredictionFragment,
): Extract<ProviderStreamChunk, { type: 'text' | 'reasoning' }> | null {
  if (!fragment.content) return null
  if (fragment.reasoningType === 'reasoning') {
    return { type: 'reasoning', text: fragment.content }
  }
  if (
    fragment.reasoningType === 'reasoningStartTag' ||
    fragment.reasoningType === 'reasoningEndTag'
  ) {
    return null
  }
  return { type: 'text', text: fragment.content }
}

function toolCallChunk(
  callId: number,
  request: FunctionToolCallRequest,
): Extract<ProviderStreamChunk, { type: 'tool_call' }> {
  return {
    type: 'tool_call',
    toolCall: {
      id: request.id ?? `lmstudio-${callId.toString()}`,
      name: request.name,
      args: request.arguments ?? {},
    },
  }
}

function mapStopReason(reason: PredictionResult['stats']['stopReason']): string {
  if (reason === 'toolCalls') return 'tool_calls'
  if (reason === 'maxPredictedTokensReached' || reason === 'contextLengthReached') {
    return 'max_tokens'
  }
  if (reason === 'eosFound' || reason === 'stopStringFound') return 'stop'
  return reason
}

function toLmStudioTools(tools: LLMTool[]): LMStudioTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: lmStudioToolParameters(tool.parameters),
    },
  }))
}

function lmStudioToolParameters(
  parameters: Record<string, unknown>,
): NonNullable<LMStudioTool['function']['parameters']> {
  const properties = isRecord(parameters['properties']) ? parameters['properties'] : {}
  const required = Array.isArray(parameters['required'])
    ? parameters['required'].filter((value): value is string => typeof value === 'string')
    : undefined
  const defs = isRecord(parameters['$defs']) ? parameters['$defs'] : undefined
  const additionalProperties =
    typeof parameters['additionalProperties'] === 'boolean'
      ? parameters['additionalProperties']
      : undefined
  return {
    type: 'object',
    properties,
    ...(required ? { required } : {}),
    ...(defs ? { $defs: defs } : {}),
    ...(additionalProperties !== undefined ? { additionalProperties } : {}),
  }
}

async function toLmStudioChat(messages: LLMMessage[], client: ClientAdapter): Promise<Chat> {
  const chat = Chat.empty()
  for (const message of messages) {
    if (message.role === 'system') {
      chat.append('system', message.content)
      continue
    }
    // LM Studio's Chat has no `developer` role, and a local chat template would
    // not accept OpenAI's anyway — which is why `operatorInstructionPlacement`
    // routes every non-cloud namespace down the `leading-system` path and this
    // branch should never be reached in practice. It is still the strongest
    // operator channel the transport has, so carry it as `system` rather than
    // dropping the instruction if that routing ever changes.
    if (message.role === 'developer') {
      chat.append('system', message.content)
      continue
    }
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        chat.append('user', message.content)
        continue
      }
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
      const images = await Promise.all(
        message.content
          .filter((part) => part.type === 'image')
          .map((part, index) => prepareImage(client, part.dataUrl, index)),
      )
      chat.append('user', text, images.length ? { images } : undefined)
      continue
    }
    if (message.role === 'assistant') {
      if (typeof message.content === 'string') {
        chat.append('assistant', message.content)
        continue
      }
      chat.append({
        role: 'assistant',
        content: message.content.map((call) => ({
          type: 'toolCallRequest',
          toolCallRequest: {
            type: 'function',
            id: call.id,
            name: call.name,
            arguments: isRecord(call.args) ? call.args : {},
          },
        })),
      })
      continue
    }
    chat.append({
      role: 'tool',
      content: message.toolResults.map((result) => ({
        type: 'toolCallResult',
        toolCallId: result.toolCallId,
        content: result.result,
      })),
    })
  }
  return chat
}

async function prepareImage(
  client: ClientAdapter,
  dataUrl: string,
  index: number,
): Promise<FileHandle> {
  const match = /^data:(image\/[^;,]+);base64,([^]*)$/i.exec(dataUrl)
  if (!match?.[1] || !match[2]) throw new Error('LM Studio image input must be a base64 data URL')
  const subtype = match[1].slice('image/'.length).replace(/[^a-z0-9]/gi, '') || 'png'
  const extension = subtype.toLowerCase() === 'jpeg' ? 'jpg' : subtype.toLowerCase()
  return client.prepareImageBase64(`copse-image-${index.toString()}.${extension}`, match[2])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Convert the configured OpenAI-compatible URL to the SDK's WebSocket origin. */
export function lmStudioWebSocketUrl(openAiBaseUrl: string): string {
  const url = new URL(openAiBaseUrl)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`Unsupported LM Studio URL protocol: ${url.protocol}`)
  }
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}
