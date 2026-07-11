import type { StreamChunk } from './types/index.ts'
import type { SseEvent } from './remote-agent-stream.ts'

/**
 * Codex Cloud agent stream events follow OpenAI's Responses-style vocabulary:
 * the discriminator is the SSE `event:` line (e.g. `response.output_text.delta`,
 * `response.completed`), and the JSON `data` payload carries the delta/item.
 * This module maps that vocabulary onto the same StreamChunk shape the renderer
 * already consumes for local, Cursor, and Claude runs, so the transcript renders
 * identically regardless of provider.
 *
 * TODO(api-verify): The exact Codex Cloud event names and payload fields are
 * modeled on the public Responses streaming API plus the cloud task additions;
 * confirm the `response.output_text.delta`, tool-call, `response.completed`, and
 * `error` shapes against the Codex Cloud API before relying on auto PR creation.
 */
export interface CodexAgentStreamState {
  /** Tool-call ids already surfaced, so a repeated event isn't re-emitted. */
  seenToolCalls: Set<string>
  assistantText: string
  /** Set once a terminal `response.completed`/`response.failed` event arrives. */
  terminalStatus: string | null
  done: boolean
}

export function createCodexAgentStreamState(): CodexAgentStreamState {
  return { seenToolCalls: new Set(), assistantText: '', terminalStatus: null, done: false }
}

interface CodexEventPayload {
  // response.output_text.delta — incremental assistant text
  delta?: string
  // response.output_item.done / .added — a completed output item (message or tool call)
  item?: {
    type?: string
    id?: string
    // function/tool call
    call_id?: string
    name?: string
    arguments?: unknown
    output?: unknown
    // message item content blocks
    content?: unknown
  }
  // response.completed / response.failed
  response?: {
    status?: string
    error?: { message?: string; code?: string }
  }
  // error
  message?: string
  code?: string
}

function formatJson(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        !!block &&
        typeof block === 'object' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('')
}

/**
 * Map a single Codex Cloud SSE event to renderer chunks, mutating `state` to
 * track accumulated text and seen tool calls. Returns `[]` for events we don't
 * surface (reasoning summaries, in-progress items, unknown types). Throws on a
 * terminal `error`/`response.failed` so the caller classifies it like any other
 * run failure.
 */
export function codexAgentEventToChunks(
  event: SseEvent,
  state: CodexAgentStreamState,
): StreamChunk[] {
  let payload: CodexEventPayload
  try {
    payload = JSON.parse(event.data) as CodexEventPayload
  } catch {
    return []
  }

  if (event.event === 'response.output_text.delta') {
    const text = payload.delta ?? ''
    if (!text) return []
    state.assistantText += text
    return [{ type: 'text', text }]
  }

  if (event.event === 'response.output_item.done' || event.event === 'response.output_item.added') {
    const item = payload.item
    if (!item) return []

    // A completed function/tool call: surface the call and, when present, its result.
    if (item.type === 'function_call' || item.type === 'tool_call') {
      const id = item.call_id ?? item.id
      const name = item.name
      if (!id || !name) return []
      const chunks: StreamChunk[] = []
      if (!state.seenToolCalls.has(id)) {
        state.seenToolCalls.add(id)
        chunks.push({
          type: 'tool_call',
          toolCall: { id, name, args: item.arguments ?? {} },
        })
      }
      if (item.output !== undefined) {
        chunks.push({
          type: 'tool_result',
          toolCallId: id,
          result: formatJson(item.output),
          isError: false,
        })
      }
      return chunks
    }

    // A completed message item only when we haven't been streaming deltas (some
    // task events deliver the final message whole rather than as deltas).
    if (item.type === 'message' && !state.assistantText) {
      const text = extractText(item.content)
      if (!text) return []
      state.assistantText += text
      return [{ type: 'text', text }]
    }
    return []
  }

  if (event.event === 'response.completed') {
    state.terminalStatus = payload.response?.status ?? 'completed'
    state.done = true
    return []
  }

  if (event.event === 'response.failed' || event.event === 'error') {
    const err = payload.response?.error ?? { message: payload.message, code: payload.code }
    const suffix = err.code ? ` (${err.code})` : ''
    throw new Error(`Codex Cloud Agent stream error${suffix}: ${err.message ?? 'unknown error'}`)
  }

  return []
}
