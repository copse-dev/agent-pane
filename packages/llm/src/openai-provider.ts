import OpenAI from 'openai'
import type {
  ImageDetail,
  LLMProvider,
  LLMMessage,
  LLMStreamOptions,
  LLMTool,
  ModelUsage,
  ProviderStreamChunk,
} from './wire-types.ts'
import { withAppAttribution } from './app-attribution.ts'
import {
  isImageUnsupportedError,
  isOutputCeilingRejectedError,
  yieldStreamWithRetry,
} from './stream-retry.ts'
import { parseToolArgs } from './parse-tool-args.ts'
import { isServiceTier, serviceTierBody, type ServiceTier } from './service-tier.ts'
import { toolCallIdOrSynthesized } from './tool-call-id.ts'
import { dropImageContent, toolResultImageFollowUp } from './tool-result-images.ts'
import { openAiParameterFields, type ModelParameters } from './model-parameters.ts'
import { markOpenRouterCacheBreakpoints } from './openrouter-prompt-cache.ts'
import { PromptCacheDiagnostics } from './prompt-cache-diagnostics.ts'

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
  lastUsage: ModelUsage | null = null

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
      serviceTier?: ServiceTier
      params?: ModelParameters
      maxOutputTokens?: number
      /** Explicit block caching, enabled only for Claude through OpenRouter. */
      openRouterCache?: boolean
    } = {},
  ) {
    this.model = model
    this.includeUsage = opts.includeUsage ?? !opts.baseURL
    this.extraBody = opts.extraBody
    this.promptCacheKey = opts.promptCacheKey
    this.cacheDiagnostics = new PromptCacheDiagnostics(
      'chat-completions',
      model,
      opts.baseURL ?? 'https://api.openai.com/v1',
      opts.promptCacheKey,
    )
    this.serviceTier = opts.serviceTier
    this.maxOutputTokens = opts.maxOutputTokens
    this.openRouterCache = opts.openRouterCache ?? false
    // Already sanitized for the selected model by the caller; empty unless the
    // user tuned this model, so an untouched request body is unchanged.
    this.tuned = openAiParameterFields(opts.params ?? {})
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? process.env['OPENAI_API_KEY'] ?? 'not-needed',
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      defaultHeaders: withAppAttribution(opts.defaultHeaders),
      // yieldStreamWithRetry owns the request budget. Leaving the SDK's two
      // retries enabled would multiply that outer budget — most importantly,
      // one routing-policy replay could become six HTTP requests for a 503.
      maxRetries: 0,
    })
  }

  private readonly includeUsage: boolean
  private readonly cacheDiagnostics: PromptCacheDiagnostics
  private readonly openRouterCache: boolean
  private readonly extraBody: Record<string, unknown> | undefined
  private readonly promptCacheKey: string | undefined
  private readonly serviceTier: ServiceTier | undefined
  private readonly tuned: ReturnType<typeof openAiParameterFields>
  /**
   * Output ceiling published by the model's own card for the reasoning level
   * this provider was built with (`recommendedOutputCeiling`). Absent for every
   * model we hold no card for, which is all but a handful — those keep sending
   * no `max_tokens` at all, exactly as before.
   */
  private readonly maxOutputTokens: number | undefined

  stream(
    messages: LLMMessage[],
    tools: LLMTool[],
    signal?: AbortSignal,
    options?: LLMStreamOptions,
  ): AsyncIterable<ProviderStreamChunk> {
    const { client, model } = this
    const self = this
    return yieldStreamWithRetry(
      async function* () {
        const mappedTools = tools.length
          ? tools.map((t, i) => ({
              type: 'function' as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: normalizeOpenAIToolSchema(t.parameters),
              },
              ...(self.openRouterCache && i === tools.length - 1
                ? { cache_control: { type: 'ephemeral' as const } }
                : {}),
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
        let reportCache: ((usage: ModelUsage | null) => void) | undefined
        for (;;) {
          try {
            const request = {
              model,
              stream: true as const,
              messages: self.openRouterCache
                ? markOpenRouterCacheBreakpoints(toOpenAIMessages(outbound))
                : toOpenAIMessages(outbound),
              ...(self.includeUsage ? { stream_options: { include_usage: true } } : {}),
              ...(mappedTools ? { tools: mappedTools } : {}),
              ...(self.promptCacheKey ? { prompt_cache_key: self.promptCacheKey } : {}),
              ...serviceTierBody(self.serviceTier),
              ...(ceiling === undefined ? {} : { max_tokens: ceiling }),
              // Provider-specific defaults normally win. A call-scoped exact
              // tool choice comes last because it enforces a host completion
              // invariant and must not be weakened back to `auto`.
              ...self.tuned,
              ...(self.extraBody ?? {}),
              ...(options?.toolChoice
                ? {
                    tool_choice: {
                      type: 'function' as const,
                      function: { name: options.toolChoice.name },
                    },
                  }
                : {}),
            }
            const leading = request.messages[0]
            reportCache = self.cacheDiagnostics.begin(
              leading?.role === 'system' || leading?.role === 'developer' ? leading : null,
              request.tools,
            )
            stream = await client.chat.completions.create(request, { signal })
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
        let streamUsage: ModelUsage | null = null
        let responseServiceTier: ServiceTier | undefined
        let hostingProvider: string | undefined

        for await (const event of stream) {
          // OpenRouter adds `provider` outside the OpenAI SDK's declared shape.
          // Accept only a bounded label, never arbitrary response/error bodies.
          const reportedHost: unknown = Reflect.get(event, 'provider')
          if (
            typeof reportedHost === 'string' &&
            /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,79}$/.test(reportedHost)
          ) {
            hostingProvider = reportedHost.trim()
          }
          if (typeof event.service_tier === 'string' && isServiceTier(event.service_tier)) {
            responseServiceTier = event.service_tier
          }
          if (event.usage) {
            const cacheReadTokens = event.usage.prompt_tokens_details?.cached_tokens
            const details = event.usage.prompt_tokens_details
            const cacheCreationTokens =
              details && 'cache_write_tokens' in details ? details.cache_write_tokens : undefined
            streamUsage = {
              inputTokens: event.usage.prompt_tokens,
              outputTokens: event.usage.completion_tokens,
              ...(typeof cacheReadTokens === 'number' ? { cacheReadTokens } : {}),
              ...(typeof cacheCreationTokens === 'number' &&
              Number.isFinite(cacheCreationTokens) &&
              cacheCreationTokens >= 0
                ? { cacheCreationTokens }
                : {}),
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
            ...(hostingProvider === undefined ? {} : { hostingProvider }),
            inputTokens: streamUsage.inputTokens,
            outputTokens: streamUsage.outputTokens,
            ...(streamUsage.cacheReadTokens !== undefined
              ? { cacheReadTokens: streamUsage.cacheReadTokens }
              : {}),
            ...(streamUsage.cacheCreationTokens !== undefined
              ? { cacheCreationTokens: streamUsage.cacheCreationTokens }
              : {}),
            ...(self.serviceTier !== undefined ? { requestedServiceTier: self.serviceTier } : {}),
            ...(responseServiceTier !== undefined ? { responseServiceTier } : {}),
          }
        }
        reportCache(streamUsage)
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

function toOpenAIMessages(messages: LLMMessage[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.flatMap((m): OpenAI.ChatCompletionMessageParam[] => {
    if (m.role === 'system') return [{ role: 'system', content: m.content }]
    if (m.role === 'developer') return [{ role: 'developer', content: m.content }]
    if (m.role === 'user' && typeof m.content === 'string')
      return [{ role: 'user', content: m.content }]
    if (m.role === 'user' && Array.isArray(m.content)) {
      return [
        {
          role: 'user',
          content: toOpenAIContent(m.content),
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
      return [...toolMessages, { role: 'user' as const, content: toOpenAIContent(images) }]
    }
    return []
  })
}

function toOpenAIContent(
  content: Array<{ type: string; text?: string; dataUrl?: string; detail?: ImageDetail }>,
): OpenAI.ChatCompletionContentPart[] {
  return content.map((c) => {
    if (c.type === 'text') return { type: 'text', text: c.text ?? '' }
    if (c.type === 'image' && c.dataUrl) {
      return {
        type: 'image_url',
        // `detail` rides on the individual part, because fidelity is a property
        // of the image: a pasted stack trace needs 'high' to stay legible while
        // a batch of frames is fine at 'low'. Omitted entirely at 'auto' rather
        // than sent explicitly — that is already OpenAI's default, and the
        // OpenAI-compatible servers this adapter also drives can reject fields
        // they don't recognise.
        image_url: {
          url: c.dataUrl,
          ...(c.detail && c.detail !== 'auto' ? { detail: c.detail } : {}),
        },
      }
    }
    return { type: 'text', text: '' }
  })
}
