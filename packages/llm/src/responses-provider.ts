import OpenAI from 'openai'
import type {
  FunctionTool,
  Response,
  ResponseInput,
  ResponseStreamEvent,
  Tool,
} from 'openai/resources/responses/responses'
import { withAppAttribution } from './app-attribution.ts'
import { parseToolArgs } from './parse-tool-args.ts'
import { serviceTierBody } from './service-tier.ts'
import { toolCallIdOrSynthesized } from './tool-call-id.ts'
import { yieldStreamWithRetry } from './stream-retry.ts'
import { toolResultImageFollowUp } from './tool-result-images.ts'
import type { LLMMessage, LLMProvider, LLMTool, ProviderStreamChunk } from './wire-types.ts'
import { responsesParameterFields, type ModelParameters } from './model-parameters.ts'

/**
 * Provider adapter for OpenAI-compatible Responses API endpoints.
 *
 * Copse's existing OpenAI adapter uses Chat Completions. Responses endpoints
 * differ in their message, function-call, and streaming event shapes, so they
 * need a distinct transport even when the same OpenAI SDK supplies the client.
 */
export class ResponsesProvider implements LLMProvider {
  private readonly client: OpenAI
  private readonly model: string
  private readonly serverTools: Tool[]
  private readonly extraBody: Record<string, unknown> | undefined
  private readonly serviceTier: string | undefined
  /** User-tuned reasoning / sampling, in this API's request shape. */
  private readonly tuned: ReturnType<typeof responsesParameterFields>
  private readonly promptCacheKey: string | undefined
  private readonly reasoningSummaries: boolean
  private readonly encryptedReasoning: boolean
  lastUsage: { inputTokens: number; outputTokens: number } | null = null

  /**
   * Reasoning items from earlier turns of this run, keyed by the id of the first
   * tool call they preceded.
   *
   * Kept on the provider rather than in `LLMMessage` on purpose. These blobs are
   * opaque, OpenAI-specific, and meaningless to any other provider; putting them
   * in the app's neutral message history would push a vendor detail through the
   * agent loop, thread storage, and every other adapter. The provider instance
   * already has exactly the right lifetime — `agent-service` builds one per run,
   * and a run is precisely the tool-calling chain over which reasoning should
   * carry.
   */
  private readonly reasoningByToolCall = new Map<string, ReasoningItem[]>()

  constructor(
    model: string,
    opts: {
      /** Omitted for first-party OpenAI, which uses the SDK's default endpoint. */
      baseURL?: string
      apiKey: string
      serverTools?: Tool[]
      extraBody?: Record<string, unknown>
      /** OpenAI `service_tier` (e.g. `'flex'`, `'priority'`). Omitted when unset. */
      serviceTier?: string
      params?: ModelParameters
      promptCacheKey?: string
      /** Ask for visible reasoning summaries (`reasoning.summary: 'auto'`). */
      reasoningSummaries?: boolean
      /** Ask for encrypted reasoning and replay it on later turns of the run. */
      encryptedReasoning?: boolean
    },
  ) {
    this.model = model
    this.serverTools = opts.serverTools ?? []
    this.extraBody = opts.extraBody
    this.serviceTier = opts.serviceTier
    this.tuned = responsesParameterFields(opts.params ?? {})
    this.promptCacheKey = opts.promptCacheKey
    this.reasoningSummaries = opts.reasoningSummaries ?? false
    this.encryptedReasoning = opts.encryptedReasoning ?? false
    this.client = new OpenAI({
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      apiKey: opts.apiKey,
      defaultHeaders: withAppAttribution(),
    })
  }

  stream(
    messages: LLMMessage[],
    tools: LLMTool[],
    signal?: AbortSignal,
  ): AsyncIterable<ProviderStreamChunk> {
    const self = this
    return yieldStreamWithRetry(
      async function* () {
        const localTools: FunctionTool[] = tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: false,
        }))
        const response = await self.client.responses.create(
          {
            model: self.model,
            input: toResponsesInput(messages, self.reasoningByToolCall),
            stream: true,
            tools: [...self.serverTools, ...localTools],
            ...(self.reasoningSummaries ? { reasoning: { summary: 'auto' as const } } : {}),
            // Without this, `store: false` leaves nothing to replay: OpenAI
            // holds no server-side copy, so the encrypted blob has to come back
            // on the response itself or the reasoning is gone.
            ...(self.encryptedReasoning
              ? { include: ['reasoning.encrypted_content' as const] }
              : {}),
            ...(self.promptCacheKey ? { prompt_cache_key: self.promptCacheKey } : {}),
            ...serviceTierBody(self.serviceTier),
            // Last, so an explicit extraBody entry still wins — that field is
            // the user's own escape hatch for provider-specific overrides.
            ...self.tuned,
            ...(self.extraBody ?? {}),
          },
          { signal },
        )

        // Reasoning items seen in *this* response, in order. Flushed onto each
        // tool call the model emits after them.
        const turnReasoning: ReasoningItem[] = []
        for await (const event of response) {
          yield* streamEventChunks(event, self.model, self, turnReasoning)
        }
      },
      { ...(signal ? { signal } : {}) },
    )
  }

  /** Record the reasoning that led to `toolCallId`, for replay on later turns. */
  rememberReasoning(toolCallId: string, items: readonly ReasoningItem[]): void {
    if (!this.encryptedReasoning || items.length === 0) return
    this.reasoningByToolCall.set(toolCallId, [...items])
  }
}

/**
 * A reasoning output item as it must be replayed on a later turn: the id OpenAI
 * assigned it plus its encrypted payload. `summary` is required by the request
 * schema but carries no information back — the visible text was already streamed.
 */
export interface ReasoningItem {
  type: 'reasoning'
  id: string
  summary: []
  encrypted_content: string
}

/** Read a streamed reasoning output item, if it carries a replayable payload. */
function toReasoningItem(item: { type: string; id?: string }): ReasoningItem | null {
  if (item.type !== 'reasoning' || !item.id) return null
  const encrypted = 'encrypted_content' in item ? item.encrypted_content : undefined
  if (typeof encrypted !== 'string' || encrypted === '') return null
  return { type: 'reasoning', id: item.id, summary: [], encrypted_content: encrypted }
}

function* streamEventChunks(
  event: ResponseStreamEvent,
  model: string,
  provider: ResponsesProvider,
  turnReasoning: ReasoningItem[],
): Generator<ProviderStreamChunk> {
  if (event.type === 'response.output_text.delta') {
    yield { type: 'text', text: event.delta }
    return
  }
  if (
    event.type === 'response.reasoning_text.delta' ||
    event.type === 'response.reasoning_summary_text.delta'
  ) {
    yield { type: 'reasoning', text: event.delta }
    return
  }
  if (event.type === 'response.output_item.done') {
    const reasoning = toReasoningItem(event.item)
    if (reasoning) {
      // Replace rather than append when the id repeats: OpenAI encrypts per
      // event, so the same reasoning can arrive under two different ciphertexts
      // (once here, once in the final payload). Keeping both would replay one
      // item twice. This is the bug LLM 0.32 fixed after its own rc2.
      const existing = turnReasoning.findIndex((item) => item.id === reasoning.id)
      if (existing === -1) turnReasoning.push(reasoning)
      else turnReasoning[existing] = reasoning
      return
    }
  }
  if (event.type === 'response.output_item.done' && event.item.type === 'function_call') {
    const parsed = parseToolArgs(event.item.arguments)
    provider.rememberReasoning(event.item.call_id, turnReasoning)
    yield {
      type: 'tool_call',
      toolCall: {
        // OpenAI always sets call_id, but this adapter also drives third-party
        // Responses-compatible endpoints (e.g. Perplexity) that may not.
        id: toolCallIdOrSynthesized(event.item.call_id),
        name: event.item.name,
        args: parsed.args,
        ...(parsed.error ? { argsError: parsed.error } : {}),
      },
    }
    return
  }
  if (event.type === 'response.completed') {
    yield* usageChunks(event.response, model, provider)
    const calledTool = event.response.output.some((item) => item.type === 'function_call')
    yield { type: 'done', stopReason: calledTool ? 'tool_calls' : 'stop' }
    return
  }
  if (event.type === 'response.incomplete') {
    yield* usageChunks(event.response, model, provider)
    const reason = event.response.incomplete_details?.reason
    yield {
      type: 'done',
      stopReason: reason === 'max_output_tokens' ? 'max_tokens' : (reason ?? 'incomplete'),
    }
    return
  }
  if (event.type === 'response.failed') {
    throw new Error(event.response.error?.message ?? 'Responses API request failed')
  }
  if (event.type === 'error') throw new Error(event.message)
}

function* usageChunks(
  response: Response,
  model: string,
  provider: ResponsesProvider,
): Generator<ProviderStreamChunk> {
  const usage = response.usage
  if (!usage) return
  provider.lastUsage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  }
  yield {
    type: 'usage',
    model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(usage.input_tokens_details.cached_tokens
      ? { cacheReadTokens: usage.input_tokens_details.cached_tokens }
      : {}),
  }
}

export function toResponsesInput(
  messages: LLMMessage[],
  reasoningByToolCall: ReadonlyMap<string, ReasoningItem[]> = new Map(),
): ResponseInput {
  return messages.flatMap((message): ResponseInput => {
    if (message.role === 'system') {
      return [{ role: 'system', content: message.content }]
    }
    if (message.role === 'user' && typeof message.content === 'string') {
      return [{ role: 'user', content: message.content }]
    }
    if (message.role === 'user' && Array.isArray(message.content)) {
      return [
        {
          role: 'user',
          content: message.content.map((part) =>
            part.type === 'image'
              ? { type: 'input_image', image_url: part.dataUrl, detail: 'auto' }
              : { type: 'input_text', text: part.text },
          ),
        },
      ]
    }
    if (message.role === 'assistant' && typeof message.content === 'string') {
      return [{ role: 'assistant', content: message.content }]
    }
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const calls: ResponseInput = message.content.map((call) => ({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.args),
      }))
      // The reasoning that produced this turn goes back ahead of the calls it
      // produced, in its original position, which is what lets the model carry a
      // line of thought across a tool-calling chain instead of restarting each
      // turn. Keyed off the first call because one reasoning block precedes the
      // whole parallel batch — replaying it per call would duplicate it.
      const first = message.content[0]
      const reasoning = first ? (reasoningByToolCall.get(first.id) ?? []) : []
      return [...reasoning, ...calls]
    }
    if (message.role === 'tool') {
      const outputs: ResponseInput = message.toolResults.map((result) => ({
        type: 'function_call_output',
        call_id: result.toolCallId,
        output: result.result,
      }))
      // A function_call_output is a plain string here too, so images a tool
      // produced follow as their own user message rather than being lost.
      const images = toolResultImageFollowUp(message.toolResults)
      if (!images || typeof images === 'string') return outputs
      return [
        ...outputs,
        {
          role: 'user',
          content: images.map((part) =>
            part.type === 'image'
              ? { type: 'input_image', image_url: part.dataUrl, detail: 'auto' }
              : { type: 'input_text', text: part.text },
          ),
        },
      ]
    }
    return []
  })
}
