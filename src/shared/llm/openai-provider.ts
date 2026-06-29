import OpenAI from 'openai'
import type { LLMProvider, LLMMessage, LLMTool, StreamChunk } from '@shared/types'
import { yieldStreamWithRetry } from './stream-retry.ts'
import { parseToolArgs } from './parse-tool-args.ts'
import { redactMessages } from './redact-secrets.ts'

type ToolCallBuilder = { id: string; name: string; argsJson: string }

function* yieldAssembledToolCalls(
  toolCallBuilders: Map<number, ToolCallBuilder>,
): Generator<StreamChunk> {
  for (const [, builder] of toolCallBuilders) {
    const parsed = parseToolArgs(builder.argsJson)
    yield {
      type: 'tool_call',
      toolCall: {
        id: builder.id,
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
  constructor(
    model: string,
    opts: {
      baseURL?: string
      apiKey?: string
      includeUsage?: boolean
      extraBody?: Record<string, unknown>
      redact?: boolean
    } = {},
  ) {
    this.model = model
    this.includeUsage = opts.includeUsage ?? !opts.baseURL
    this.extraBody = opts.extraBody
    // Redact secrets from outbound content for REMOTE providers only (#518). A
    // local/on-device server keeps the data on the machine, so redaction would
    // only degrade its context for no privacy gain. Default: redact unless this
    // is a custom-baseURL server — the only baseURL-less case is real OpenAI.
    // Callers (create-provider factories) pass `redact` explicitly so the
    // remote/local intent is decided where it is actually known.
    this.redact = opts.redact ?? !opts.baseURL
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? process.env['OPENAI_API_KEY'] ?? 'not-needed',
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    })
  }

  private readonly includeUsage: boolean
  private readonly extraBody: Record<string, unknown> | undefined
  private readonly redact: boolean

  stream(
    messages: LLMMessage[],
    tools: LLMTool[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
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
                parameters: t.parameters,
              },
            }))
          : undefined
        const stream = await client.chat.completions.create(
          {
            model,
            stream: true,
            messages: toOpenAIMessages(self.redact ? redactMessages(messages) : messages),
            ...(self.includeUsage ? { stream_options: { include_usage: true } } : {}),
            ...(mappedTools ? { tools: mappedTools } : {}),
            ...(self.extraBody ?? {}),
          },
          { signal },
        )

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
          const reasoning = readReasoningDelta(delta as unknown as Record<string, unknown>)
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
function readReasoningDelta(delta: Record<string, unknown>): string {
  const raw = delta['reasoning_content'] ?? delta['reasoning']
  return typeof raw === 'string' ? raw : ''
}

function toOpenAIMessages(messages: LLMMessage[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.flatMap((m): OpenAI.ChatCompletionMessageParam[] => {
    if (m.role === 'system') return [{ role: 'system', content: m.content }]
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
      return m.toolResults.map((tr) => ({
        role: 'tool' as const,
        tool_call_id: tr.toolCallId,
        content: tr.result,
      }))
    }
    return []
  })
}

function toOpenAIContent(
  content: Array<{ type: string; text?: string; dataUrl?: string }>,
): OpenAI.ChatCompletionContentPart[] {
  return content.map((c) => {
    if (c.type === 'text') return { type: 'text', text: c.text ?? '' }
    if (c.type === 'image' && c.dataUrl) return { type: 'image_url', image_url: { url: c.dataUrl } }
    return { type: 'text', text: '' }
  })
}
