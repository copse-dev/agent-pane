import Anthropic from '@anthropic-ai/sdk'
import type { LLMProvider, LLMMessage, LLMTool, StreamChunk } from '@shared/types'
import { anthropicMaxOutputTokens } from './model-catalog.ts'
import { yieldStreamWithRetry } from './stream-retry.ts'
import { parseToolArgs } from './parse-tool-args.ts'

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic
  private readonly model: string
  lastUsage: { inputTokens: number; outputTokens: number } | null = null

  constructor(model: string, opts: { apiKey?: string } = {}) {
    this.model = model
    this.client = new Anthropic({ apiKey: opts.apiKey ?? process.env['ANTHROPIC_API_KEY'] })
  }

  stream(
    messages: LLMMessage[],
    tools: LLMTool[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const { client, model } = this
    const self = this
    const systemMsg = messages.find((m) => m.role === 'system')
    const apiMessages = toAnthropicMessages(messages.filter((m) => m.role !== 'system'))
    const maxTokens = anthropicMaxOutputTokens(model)

    return yieldStreamWithRetry(
      async function* () {
        const stream = client.messages.stream(
          {
            model,
            max_tokens: maxTokens,
            ...(systemMsg
              ? {
                  system: [
                    {
                      type: 'text' as const,
                      text: systemMsg.content,
                      cache_control: { type: 'ephemeral' as const },
                    },
                  ],
                }
              : {}),
            messages: apiMessages,
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters as Anthropic.Messages.Tool['input_schema'],
            })),
          },
          { signal },
        )

        let currentToolId = ''
        let currentToolName = ''
        let toolJson = ''
        let stopReason: Anthropic.Messages.StopReason | null = null
        // Authoritative input/cache counts arrive on message_start; the final
        // output_tokens arrives on message_delta (#111). Accumulate both into a
        // single per-stream usage value so we never depend on a shared field.
        let inputTokens = 0
        let outputTokens = 0
        let cacheReadTokens = 0
        let cacheCreationTokens = 0

        for await (const event of stream) {
          if (event.type === 'message_start') {
            const u = event.message.usage
            cacheReadTokens = u.cache_read_input_tokens ?? 0
            cacheCreationTokens = u.cache_creation_input_tokens ?? 0
            // Total input = fresh input + cache-creation + cache-read tokens.
            inputTokens = u.input_tokens + cacheCreationTokens + cacheReadTokens
            outputTokens = u.output_tokens
          }
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
            currentToolId = event.content_block.id
            currentToolName = event.content_block.name
            toolJson = ''
          }
          if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              yield { type: 'text', text: event.delta.text }
            }
            // Extended-thinking tokens (when the model is configured to think).
            // The matching `signature_delta` is verification metadata, not text,
            // so it is intentionally ignored.
            if (event.delta.type === 'thinking_delta') {
              yield { type: 'reasoning', text: event.delta.thinking }
            }
            if (event.delta.type === 'input_json_delta') {
              toolJson += event.delta.partial_json
            }
          }
          if (event.type === 'content_block_stop' && currentToolId) {
            const parsed = parseToolArgs(toolJson)
            yield {
              type: 'tool_call',
              toolCall: {
                id: currentToolId,
                name: currentToolName,
                args: parsed.args,
                ...(parsed.error ? { argsError: parsed.error } : {}),
              },
            }
            currentToolId = ''
            currentToolName = ''
            toolJson = ''
          }
          if (event.type === 'message_delta') {
            if (event.delta.stop_reason) stopReason = event.delta.stop_reason
            // message_delta carries the final output_tokens; input_tokens is
            // usually null/0 here, so keep the message_start value if larger.
            outputTokens = event.usage.output_tokens
            if (event.usage.input_tokens) {
              inputTokens = Math.max(inputTokens, event.usage.input_tokens)
            }
          }
        }
        const usage = { inputTokens, outputTokens }
        self.lastUsage = usage
        // Emit usage per-stream so consumers can attribute it to this exact
        // stream rather than racing on the shared lastUsage field (#112).
        if (inputTokens || outputTokens) {
          yield {
            type: 'usage',
            model,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
          }
        }
        if (stopReason === 'max_tokens') {
          yield {
            type: 'text',
            text: '\n\n(Response stopped: model output limit reached.)',
          }
        }
        yield stopReason ? { type: 'done', stopReason } : { type: 'done' }
      },
      { ...(signal ? { signal } : {}) },
    )
  }
}

function toAnthropicMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
  return messages.flatMap((m): Anthropic.MessageParam[] => {
    if (m.role === 'user' && typeof m.content === 'string') {
      return [{ role: 'user', content: m.content }]
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      return [
        {
          role: 'user',
          content: toAnthropicContent(m.content),
        },
      ]
    }
    if (m.role === 'assistant' && typeof m.content === 'string') {
      return [{ role: 'assistant', content: m.content }]
    }
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      return [
        {
          role: 'assistant',
          content: m.content.map((tc) => ({
            type: 'tool_use' as const,
            id: tc.id,
            name: tc.name,
            input: tc.args as Record<string, unknown>,
          })),
        },
      ]
    }
    if (m.role === 'tool') {
      return [
        {
          role: 'user',
          content: m.toolResults.map((tr) => ({
            type: 'tool_result' as const,
            tool_use_id: tr.toolCallId,
            content: tr.result,
          })),
        },
      ]
    }
    return []
  })
}

function toAnthropicContent(
  content: Array<{ type: string; text?: string; dataUrl?: string }>,
): Anthropic.ContentBlockParam[] {
  return content.map((c) => {
    if (c.type === 'text') return { type: 'text', text: c.text ?? '' }
    if (c.type === 'image' && c.dataUrl) {
      const [header, data] = c.dataUrl.split(',')
      const mediaType = (header?.match(/:(.*?);/)?.[1] ?? 'image/png') as
        | 'image/png'
        | 'image/jpeg'
        | 'image/gif'
        | 'image/webp'
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data: data ?? '' } }
    }
    return { type: 'text', text: '' }
  })
}
