import Anthropic from '@anthropic-ai/sdk'
import type { LLMProvider, LLMMessage, LLMTool, ProviderStreamChunk } from './wire-types.ts'
import { anthropicMaxOutputTokens, supportsMidConversationSystem } from './model-catalog.ts'
import { yieldStreamWithRetry } from './stream-retry.ts'
import { parseToolArgs } from './parse-tool-args.ts'
import { toolResultContentBlocks } from './tool-result-images.ts'

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
  ): AsyncIterable<ProviderStreamChunk> {
    const { client, model } = this
    const self = this
    const { systemPrompt, conversation } = splitSystemPrompt(messages)
    const midSystem = supportsMidConversationSystem(model)
    // Any system message *after* the first is an operator instruction that
    // arrived mid-conversation (turn steering, hook-injected context). It is
    // volatile — regenerated every turn and never persisted into the thread's
    // history — so it is converted last and the cache breakpoint goes *before*
    // it. That keeps the entry this request writes a byte-identical prefix of
    // the next turn's request, instead of contaminating it with text that turn
    // will not resend (#1286).
    const operatorStart = trailingSystemStart(conversation)
    const apiMessages = toAnthropicMessages(conversation.slice(0, operatorStart), midSystem)
    markTrailingCacheBreakpoint(apiMessages)
    apiMessages.push(...toAnthropicMessages(conversation.slice(operatorStart), midSystem))
    const maxTokens = anthropicMaxOutputTokens(model)

    return yieldStreamWithRetry(
      async function* () {
        const stream = client.messages.stream(
          {
            model,
            max_tokens: maxTokens,
            ...(systemPrompt !== undefined
              ? {
                  system: [
                    {
                      type: 'text' as const,
                      text: systemPrompt,
                      cache_control: { type: 'ephemeral' as const },
                    },
                  ],
                }
              : {}),
            messages: apiMessages,
            // The last tool gets a cache breakpoint so the (large, stable) tool
            // schemas are cached instead of re-sent every loop iteration (#582).
            tools: tools.map((t, i): Anthropic.Messages.Tool => ({
              name: t.name,
              description: t.description,
              input_schema: { ...t.parameters, type: 'object' },
              ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
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

/**
 * Split the leading system message (the stable system prompt, which becomes the
 * top-level `system` parameter) from the rest of the conversation. Later system
 * messages stay in `conversation` — they are mid-conversation operator
 * instructions, not the system prompt, and are handled by
 * {@link toAnthropicMessages}.
 *
 * `systemPrompt` is `undefined` only when there is no system message at all; an
 * empty-string prompt still produces the `system` parameter, matching the
 * behaviour callers have always had.
 */
function splitSystemPrompt(messages: LLMMessage[]): {
  systemPrompt?: string
  conversation: LLMMessage[]
} {
  const index = messages.findIndex((m) => m.role === 'system')
  const leading = index >= 0 ? messages[index] : undefined
  if (!leading || leading.role !== 'system') return { conversation: messages }
  return {
    systemPrompt: leading.content,
    conversation: messages.filter((_, i) => i !== index),
  }
}

/**
 * Index where the trailing run of system messages starts (`length` when the
 * conversation does not end in one). Returns `length` when *every* message is a
 * system message, so a degenerate input still converts as a normal body rather
 * than producing a request with no messages.
 */
function trailingSystemStart(conversation: LLMMessage[]): number {
  let start = conversation.length
  while (start > 0 && conversation[start - 1]?.role === 'system') start--
  return start === 0 ? conversation.length : start
}

/**
 * Fallback channel for models without mid-conversation system messages: the
 * instruction rides a user turn wrapped in `<system-reminder>` tags. Same
 * caching profile — it lands after the last breakpoint either way — but without
 * the operator authority of a real system turn, so it is only used when the
 * model cannot accept one.
 */
function systemReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`
}

/**
 * Put a cache breakpoint on the final content block of the final message, so
 * the whole conversation prefix is cached across agent-loop iterations instead
 * of only the system prompt (#582). Each request's breakpoint lands one turn
 * further along; Anthropic then matches the previous request's breakpoint as a
 * cached prefix. String contents are converted to a single text block, which
 * the API treats identically. With the system + last-tool breakpoints this
 * stays within the 4-breakpoint API limit.
 *
 * Called with the conversation *body* only — trailing operator instructions are
 * appended after it, so the breakpoint marks the last message the next turn will
 * resend verbatim (#1286).
 */
export function markTrailingCacheBreakpoint(apiMessages: Anthropic.MessageParam[]): void {
  const last = apiMessages.at(-1)
  if (!last) return
  if (typeof last.content === 'string') {
    // An empty text block would be rejected by the API; leave such (already
    // invalid) messages untouched rather than converting them.
    if (!last.content) return
    last.content = [{ type: 'text', text: last.content }]
  }
  const block = last.content.at(-1)
  // Thinking/redacted-thinking blocks cannot carry cache_control; every block
  // shape this provider emits (text, image, tool_use, tool_result) can.
  if (!block || block.type === 'thinking' || block.type === 'redacted_thinking') return
  block.cache_control = { type: 'ephemeral' }
}

function toAnthropicMessages(
  messages: LLMMessage[],
  midConversationSystem: boolean,
): Anthropic.MessageParam[] {
  return messages.flatMap((m): Anthropic.MessageParam[] => {
    if (m.role === 'system') {
      // An empty block would be rejected by the API, and an empty operator
      // instruction says nothing anyway.
      if (!m.content) return []
      return midConversationSystem
        ? [{ role: 'system', content: m.content }]
        : [{ role: 'user', content: [{ type: 'text', text: systemReminder(m.content) }] }]
    }
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
            input: tc.args,
          })),
        },
      ]
    }
    if (m.role === 'tool') {
      return [
        {
          role: 'user',
          content: m.toolResults.map((tr) => {
            // Anthropic accepts text + image blocks inside a tool_result, so a
            // tool's images stay attributed to the call that produced them.
            const blocks = toolResultContentBlocks(tr)
            return {
              type: 'tool_result' as const,
              tool_use_id: tr.toolCallId,
              content: blocks ? toAnthropicContent(blocks) : tr.result,
            }
          }),
        },
      ]
    }
    return []
  })
}

// Narrower than ContentBlockParam on purpose: text and image are the only
// shapes produced here, and a tool_result's content accepts exactly those two.
function toAnthropicContent(
  content: Array<{ type: string; text?: string; dataUrl?: string }>,
): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
  return content.map((c) => {
    if (c.type === 'text') return { type: 'text', text: c.text ?? '' }
    if (c.type === 'image' && c.dataUrl) {
      const [header, data] = c.dataUrl.split(',')
      const parsedMediaType = header?.match(/:(.*?);/)?.[1]
      const mediaType = isImageMediaType(parsedMediaType) ? parsedMediaType : 'image/png'
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data: data ?? '' } }
    }
    return { type: 'text', text: '' }
  })
}

function isImageMediaType(
  value: unknown,
): value is 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  return (
    value === 'image/png' ||
    value === 'image/jpeg' ||
    value === 'image/gif' ||
    value === 'image/webp'
  )
}
