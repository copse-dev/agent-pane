import type { StreamChunk } from './types/index.ts'
import type { SseEvent } from './remote-agent-stream.ts'

/**
 * Claude Managed Agents stream events differ from Cursor's: the discriminator is
 * the `type` field *inside* the JSON `data` payload (e.g. `agent.message`,
 * `agent.tool_use`), not the SSE `event:` line. This module maps that vocabulary
 * onto the same StreamChunk shape the renderer already consumes for local and
 * Cursor runs, so the transcript renders identically regardless of provider.
 */
export interface ManagedAgentStreamState {
  /** Tool-use event ids already surfaced, so a repeated event isn't re-emitted. */
  seenToolCalls: Set<string>
  assistantText: string
  /** Set once a `session.status_idle` event arrives; the caller stops streaming. */
  terminalStatus: string | null
  done: boolean
}

export function createManagedAgentStreamState(): ManagedAgentStreamState {
  return { seenToolCalls: new Set(), assistantText: '', terminalStatus: null, done: false }
}

interface ManagedTextBlock {
  type?: string
  text?: string
}

interface ManagedEventPayload {
  type?: string
  // agent.message — array of content blocks (text/thinking/…)
  content?: unknown
  // agent.tool_use / agent.mcp_tool_use
  id?: string
  name?: string
  input?: unknown
  // agent.tool_result / agent.mcp_tool_result
  tool_use_id?: string
  is_error?: boolean
  result?: unknown
  // session.status_idle
  stop_reason?: { type?: string }
  // session.error
  error?: { message?: string; type?: string }
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
      (block): block is { type: 'text'; text: string } =>
        !!block &&
        typeof block === 'object' &&
        (block as ManagedTextBlock).type === 'text' &&
        typeof (block as ManagedTextBlock).text === 'string',
    )
    .map((block) => block.text)
    .join('')
}

const TOOL_USE_TYPES = new Set(['agent.tool_use', 'agent.mcp_tool_use', 'agent.custom_tool_use'])
const TOOL_RESULT_TYPES = new Set(['agent.tool_result', 'agent.mcp_tool_result'])

/**
 * Map a single Managed Agents SSE event to renderer chunks, mutating `state` to
 * track accumulated text and seen tool calls. Returns `[]` for events we don't
 * surface (spans, status transitions other than idle, unknown types). Throws on
 * `session.error` so the caller can classify it like any other run failure.
 */
export function managedAgentEventToChunks(
  event: SseEvent,
  state: ManagedAgentStreamState,
): StreamChunk[] {
  let payload: ManagedEventPayload
  try {
    payload = JSON.parse(event.data) as ManagedEventPayload
  } catch {
    return []
  }
  const type = payload.type
  if (!type) return []

  if (type === 'agent.message') {
    const text = extractText(payload.content)
    if (!text) return []
    // TODO(api-verify): This assumes `agent.message` events carry incremental
    // deltas, so each event's text is appended (`+=`). If the API instead sends
    // cumulative snapshots (each event repeating all text so far), this both
    // duplicates `assistantText` and re-emits the whole message as a text chunk
    // on every event. Confirm delta-vs-snapshot semantics; if snapshots, replace
    // the append with a diff/replace against the prior content.
    state.assistantText += text
    return [{ type: 'text', text }]
  }

  if (TOOL_USE_TYPES.has(type)) {
    const id = payload.id
    const name = payload.name
    if (!id || !name) return []
    if (state.seenToolCalls.has(id)) return []
    state.seenToolCalls.add(id)
    return [
      {
        type: 'tool_call',
        toolCall: { id, name, args: payload.input ?? {} },
      },
    ]
  }

  if (TOOL_RESULT_TYPES.has(type)) {
    const toolCallId = payload.tool_use_id
    if (!toolCallId) return []
    const result = payload.content ?? payload.result
    return [
      {
        type: 'tool_result',
        toolCallId,
        result: formatJson(result),
        isError: payload.is_error === true,
      },
    ]
  }

  if (type === 'session.status_idle') {
    // `requires_action` means the harness is waiting on a tool confirmation or a
    // custom-tool result. v1 runs the default toolset with no custom permission
    // policy, so this is treated as terminal like `end_turn` rather than driving
    // an interactive approval loop.
    state.terminalStatus = payload.stop_reason?.type ?? 'idle'
    state.done = true
    return []
  }

  if (type === 'session.error') {
    const suffix = payload.error?.type ? ` (${payload.error.type})` : ''
    throw new Error(
      `Claude Cloud Agent stream error${suffix}: ${payload.error?.message ?? 'unknown error'}`,
    )
  }

  return []
}
