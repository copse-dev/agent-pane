import OpenAI from 'openai'
import type { LLMProvider, LLMMessage, LLMTool, StreamChunk } from '@shared/types'
import { yieldStreamWithRetry } from './stream-retry.ts'
import { parseToolArgs } from './parse-tool-args.ts'

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI
  lastUsage: { inputTokens: number; outputTokens: number } | null = null

  // `baseURL` lets this provider talk to any OpenAI-compatible server (e.g.
  // LM Studio at http://localhost:1234/v1). Such servers often ignore the API
  // key but the SDK requires a non-empty value.
  constructor(
    private readonly model: string,
    opts: { baseURL?: string; apiKey?: string; includeUsage?: boolean } = {},
  ) {
    this.includeUsage = opts.includeUsage ?? !opts.baseURL
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY ?? 'not-needed',
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    })
  }

  private readonly includeUsage: boolean

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
                parameters: t.parameters as Record<string, unknown>,
              },
            }))
          : undefined
        const stream = await client.chat.completions.create(
          {
            model,
            stream: true,
            messages: toOpenAIMessages(messages),
            ...(self.includeUsage ? { stream_options: { include_usage: true } } : {}),
            ...(mappedTools ? { tools: mappedTools } : {}),
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

          if (delta.content) yield { type: 'text', text: delta.content }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index
              if (!toolCallBuilders.has(idx)) {
                toolCallBuilders.set(idx, {
                  id: tc.id ?? '',
                  name: tc.function?.name ?? '',
                  argsJson: '',
                })
              }
              const builder = toolCallBuilders.get(idx)!
              if (tc.id) builder.id = tc.id
              if (tc.function?.name) builder.name = tc.function.name
              if (tc.function?.arguments) builder.argsJson += tc.function.arguments
            }
          }

          const reason = event.choices[0]?.finish_reason
          if (reason) finishReason = reason

          if (reason === 'tool_calls') {
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
            toolCallBuilders.clear()
          }
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

function toOpenAIMessages(messages: LLMMessage[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.flatMap((m): OpenAI.ChatCompletionMessageParam[] => {
    if (m.role === 'system') return [{ role: 'system', content: m.content as string }]
    if (m.role === 'user' && typeof m.content === 'string')
      return [{ role: 'user', content: m.content }]
    if (m.role === 'user' && Array.isArray(m.content)) {
      return [
        {
          role: 'user',
          content: toOpenAIContent(
            m.content as Array<{ type: string; text?: string; dataUrl?: string }>,
          ),
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
