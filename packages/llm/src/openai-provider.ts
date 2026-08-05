import OpenAI from 'openai'
import type {
  ImageDetail,
  LLMProvider,
  LLMMessage,
  LLMTool,
  ProviderStreamChunk,
} from './wire-types.ts'
import { withAppAttribution } from './app-attribution.ts'
import {
  isImageUnsupportedError,
  isOutputCeilingRejectedError,
  yieldStreamWithRetry,
} from './stream-retry.ts'
import { parseToolArgs } from './parse-tool-args.ts'
import { serviceTierBody } from './service-tier.ts'
import { toolCallIdOrSynthesized } from './tool-call-id.ts'
import { dropImageContent, toolResultImageFollowUp } from './tool-result-images.ts'
import { openAiParameterFields, type ModelParameters } from './model-parameters.ts'

type ToolCallBuilder = { id: string; name: string; argsJson: string }

function normalizeExclusiveBound(
  schema: Record<string, unknown>,
  inclusiveKey: 'minimum' | 'maximum',
  exclusiveKey: 'exclusiveMinimum' | 'exclusiveMaximum',
): void {
  const exclusive = schema[exclusiveKey]
  if (typeof exclusive !== 'boolean') return
  const inclusive = schema[inclusiveKey]
  if (exclusive && typeof inclusive === 'number') {
    schema[exclusiveKey] = inclusive
    Reflect.deleteProperty(schema, inclusiveKey)
    return
  }
  Reflect.deleteProperty(schema, exclusiveKey)
}

/**
 * OpenAPI 3 represents exclusive numeric bounds as a boolean beside
 * `minimum`/`maximum`; current JSON Schema represents the exclusive keyword as
 * the bound itself. Some OpenAI-compatible servers validate tool parameters
 * against the current metaschema and reject the legacy boolean form before the
 * model runs. Clone and normalize recursively at this transport boundary so the
 * registry and the caller-owned schema remain unchanged.
 */
function normalizeOpenAIToolSchema(value: Record<string, unknown>): Record<string, unknown>
function normalizeOpenAIToolSchema(value: unknown): unknown
function normalizeOpenAIToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeOpenAIToolSchema(item))
  if (!value || typeof value !== 'object') return value

  const normalized: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    normalized[key] = normalizeOpenAIToolSchema(child)
  }
  normalizeExclusiveBound(normalized, 'minimum', 'exclusiveMinimum')
  normalizeExclusiveBound(normalized, 'maximum', 'exclusiveMaximum')
  return normalized
}

function* yieldAssembledToolCalls(
  toolCallBuilders: Map<number, ToolCallBuilder>,
): Generator<ProviderStreamChunk> {
  for (const [, builder] of toolCallBuilders) {
    const parsed = parseToolArgs(builder.argsJson)
    yield {
      type: 'tool_call',
      toolCall: {
        // Synthesized here rather than when the builder is created: the id can
        // arrive in any delta of the call, so it is only known to be absent
        // once the whole call has been assembled.
        id: toolCallIdOrSynthesized(builder.id),
        name: builder.name,
        args: parsed.args,
        ...(parsed.error ? { argsError: parsed.error } : {}),
      },
    }
  }
}

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI
  private readonly model: string
  lastUsage: { inputTokens: number; outputTokens: number } | null = null

  // `baseURL` lets this provider talk to any OpenAI-compatible server (e.g.
  // LM Studio at http://localhost:1234/v1). Such servers often ignore the API
  // key but the SDK requires a non-empty value. `extraBody` is merged into every
  // request body — used to pass provider-specific fields (e.g. OpenRouter's
  // `provider: { require_parameters: true }`) that aren't in the OpenAI schema.
  // `promptCacheKey` is sent as OpenAI's `prompt_cache_key`: a stable per-thread
  // hint that routes a conversation's repeated turns to the same cache, raising
  // prompt-cache hit rates (and lowering cost) on providers that honour it (#584).
  // `defaultHeaders` is merged over the app-attribution pair every request
  // carries (see app-attribution.ts) — used for router-specific headers such as
  // OpenRouter's `X-OpenRouter-Title`.
  constructor(
    model: string,
    opts: {
      baseURL?: string
      apiKey?: string
      includeUsage?: boolean
      extraBody?: Record<string, unknown>
      promptCacheKey?: string
      defaultHeaders?: Readonly<Record<string, string>>
      /** OpenAI `service_tier` (e.g. `'flex'`, `'priority'`). Omitted when unset. */
      serviceTier?: string
      params?: ModelParameters
      maxOutputTokens?: number
      /** Image fidelity to request. Defaults to `'auto'` — the historical behaviour. */
      imageDetail?: ImageDetail
    } = {},
  ) {
    this.model = model
    this.includeUsage = opts.includeUsage ?? !opts.baseURL
    this.extraBody = opts.extraBody
    this.promptCacheKey = opts.promptCacheKey
    this.serviceTier = opts.serviceTier
    this.maxOutputTokens = opts.maxOutputTokens
    // Already sanitized for the selected model by the caller; empty unless the
    // user tuned this model, so an untouched request body is unchanged.
    this.tuned = openAiParameterFields(opts.params ?? {})
    this.imageDetail = opts.imageDetail ?? 'auto'
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? process.env['OPENAI_API_KEY'] ?? 'not-needed',
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      defaultHeaders: withAppAttribution(opts.defaultHeaders),
    })
  }

  private readonly includeUsage: boolean
  private readonly extraBody: Record<string, unknown> | undefined
  private readonly promptCacheKey: string | undefined
  private readonly serviceTier: string | undefined
  private readonly tuned: ReturnType<typeof openAiParameterFields>
  /**
   * Output ceiling published by the model's own card for the reasoning level
   * this provider was built with (`recommendedOutputCeiling`). Absent for every
   * model we hold no card for, which is all but a handful — those keep sending
   * no `max_tokens` at all, exactly as before.
   */
  private readonly maxOutputTokens: number | undefined
  private readonly imageDetail: ImageDetail

  stream(
    messages: LLMMessage[],
    tools: LLMTool[],
    signal?: AbortSignal,
  ): AsyncIterable<ProviderStreamChunk> {
    const { client, model } = this
    const self = this
    return yieldStreamWithRetry(
      async function* () {
        const mappedTools = tools.length
          ? tools.map((t) => ({
              type: 'function' as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: normalizeOpenAIToolSchema(t.parameters),
              },
            }))
          : undefined
        // Two request-changing retries, each taken at most once. Deliberately
        // not part of `isRetryableStreamError`: those are blind replays, and
        // these send something different.
        //
        //  - A server that cannot take images (a text-only local model, or one
        //    that only accepts certain encodings) rejects the whole request.
        //    Retry without them rather than failing the turn — the tool result's
        //    text still describes what the images showed.
        //  - A published output ceiling the endpoint won't accept: drop it and
        //    let the server's own default stand. Nothing the user chose is lost;
        //    the ceiling was ours to offer, not theirs to set.
        let outbound = messages
        let ceiling = self.maxOutputTokens
        let droppedImages = false
        let droppedCeiling = false
        let stream
        for (;;) {
          try {
            stream = await client.chat.completions.create(
              {
                model,
                stream: true,
                messages: toOpenAIMessages(outbound, self.imageDetail),
                ...(self.includeUsage ? { stream_options: { include_usage: true } } : {}),
                ...(mappedTools ? { tools: mappedTools } : {}),
                ...(self.promptCacheKey ? { prompt_cache_key: self.promptCacheKey } : {}),
                ...serviceTierBody(self.serviceTier),
                ...(ceiling === undefined ? {} : { max_tokens: ceiling }),
                // Last, so an explicit extraBody entry still wins — that field is
                // the user's own escape hatch for provider-specific overrides.
                ...self.tuned,
                ...(self.extraBody ?? {}),
              },
              { signal },
            )
            break
          } catch (err) {
            if (!droppedImages && isImageUnsupportedError(err)) {
              droppedImages = true
              outbound = dropImageContent(messages)
              continue
            }
            if (!droppedCeiling && ceiling !== undefined && isOutputCeilingRejectedError(err)) {
              droppedCeiling = true
              ceiling = undefined
              continue
            }
            throw err
          }
        }

        const toolCallBuilders = new Map<number, { id: string; name: string; argsJson: string }>()
        let finishReason: string | undefined
        let streamUsage: { inputTokens: number; outputTokens: number } | null = null

        for await (const event of stream) {
          if (event.usage) {
            streamUsage = {
              inputTokens: event.usage.prompt_tokens,
              outputTokens: event.usage.completion_tokens,
            }
            self.lastUsage = streamUsage
          }
          const delta = event.choices[0]?.delta
          if (!delta) continue

          // Reasoning ("thinking") tokens. Not part of the OpenAI schema, but
          // widely emitted by OpenAI-compatible servers under one of these field
          // names: `reasoning_content` (DeepSeek, vLLM, LM Studio) or `reasoning`
          // (OpenRouter). Surfaced as a separate chunk so it never leaks into the
          // answer text or the history sent back upstream.
          const reasoning = readReasoningDelta(delta)
          if (reasoning) yield { type: 'reasoning', text: reasoning }

          if (delta.content) yield { type: 'text', text: delta.content }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index
              let builder = toolCallBuilders.get(idx)
              if (!builder) {
                builder = {
                  id: tc.id ?? '',
                  name: tc.function?.name ?? '',
                  argsJson: '',
                }
                toolCallBuilders.set(idx, builder)
              }
              if (tc.id) builder.id = tc.id
              if (tc.function?.name) builder.name = tc.function.name
              if (tc.function?.arguments) builder.argsJson += tc.function.arguments
            }
          }

          const reason = event.choices[0]?.finish_reason
          if (reason) finishReason = reason

          if (reason === 'tool_calls') {
            yield* yieldAssembledToolCalls(toolCallBuilders)
            toolCallBuilders.clear()
          }
        }
        // Some OpenAI-compatible servers finish with `stop` while still streaming tool deltas.
        if (toolCallBuilders.size > 0) {
          yield* yieldAssembledToolCalls(toolCallBuilders)
          toolCallBuilders.clear()
        }
        // Emit usage per-stream so consumers attribute it to this exact stream
        // rather than racing on the shared lastUsage field (#112).
        if (streamUsage && (streamUsage.inputTokens || streamUsage.outputTokens)) {
          yield {
            type: 'usage',
            model,
            inputTokens: streamUsage.inputTokens,
            outputTokens: streamUsage.outputTokens,
          }
        }
        yield finishReason ? { type: 'done', stopReason: finishReason } : { type: 'done' }
      },
      { ...(signal ? { signal } : {}) },
    )
  }
}

/**
 * Pull a reasoning-token string out of a streamed chat-completion delta. OpenAI's
 * own schema has no reasoning field, so compatible servers bolt one on under
 * different names — accept the two common ones and ignore non-string values.
 */
function readReasoningDelta(delta: object): string {
  const reasoningContent = 'reasoning_content' in delta ? delta.reasoning_content : undefined
  const raw = reasoningContent ?? ('reasoning' in delta ? delta.reasoning : undefined)
  return typeof raw === 'string' ? raw : ''
}

function toOpenAIMessages(
  messages: LLMMessage[],
  imageDetail: ImageDetail = 'auto',
): OpenAI.ChatCompletionMessageParam[] {
  return messages.flatMap((m): OpenAI.ChatCompletionMessageParam[] => {
    if (m.role === 'system') return [{ role: 'system', content: m.content }]
    if (m.role === 'user' && typeof m.content === 'string')
      return [{ role: 'user', content: m.content }]
    if (m.role === 'user' && Array.isArray(m.content)) {
      return [
        {
          role: 'user',
          content: toOpenAIContent(m.content, imageDetail),
        },
      ]
    }
    if (m.role === 'assistant' && typeof m.content === 'string')
      return [{ role: 'assistant', content: m.content }]
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      return [
        {
          role: 'assistant',
          content: null,
          tool_calls: m.content.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        },
      ]
    }
    if (m.role === 'tool') {
      const toolMessages = m.toolResults.map((tr) => ({
        role: 'tool' as const,
        tool_call_id: tr.toolCallId,
        content: tr.result,
      }))
      // Chat completions only accepts a string as a tool output, so images a
      // tool produced follow as their own user message rather than being lost.
      const images = toolResultImageFollowUp(m.toolResults)
      if (!images || typeof images === 'string') return toolMessages
      return [
        ...toolMessages,
        { role: 'user' as const, content: toOpenAIContent(images, imageDetail) },
      ]
    }
    return []
  })
}

function toOpenAIContent(
  content: Array<{ type: string; text?: string; dataUrl?: string }>,
  imageDetail: ImageDetail = 'auto',
): OpenAI.ChatCompletionContentPart[] {
  return content.map((c) => {
    if (c.type === 'text') return { type: 'text', text: c.text ?? '' }
    if (c.type === 'image' && c.dataUrl) {
      return {
        type: 'image_url',
        // `detail` is omitted entirely at 'auto' rather than sent explicitly:
        // that is already OpenAI's default, and the OpenAI-compatible servers
        // this adapter also drives can reject fields they don't recognise.
        image_url: { url: c.dataUrl, ...(imageDetail === 'auto' ? {} : { detail: imageDetail }) },
      }
    }
    return { type: 'text', text: '' }
  })
}
