import type { PlanEntry, SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk'
import type { StreamChunk } from '@shared/types'
import type { TodoItem } from '@shared/types/todo.ts'

/**
 * Translate between Copse's internal `StreamChunk` stream and ACP
 * `session/update` payloads. These pure functions are the single mapping point
 * shared by both ACP roles:
 *
 * - **Agent role** (Copse is driven by an ACP client such as Buzz):
 *   {@link streamChunkToSessionUpdate} turns chunks emitted by the agent loop
 *   into updates we notify the client with.
 * - **Client role** (Copse drives an external ACP agent):
 *   {@link sessionUpdateToStreamChunk} turns updates received from the agent
 *   back into chunks the renderer already knows how to display.
 *
 * Chunks/updates without a clean counterpart (usage accounting, context
 * pressure, internal subagent events) map to `null` and are dropped.
 */
export function streamChunkToSessionUpdate(chunk: StreamChunk): SessionUpdate | null {
  switch (chunk.type) {
    case 'text':
    case 'text_replace':
      return {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: chunk.text },
      }
    case 'reasoning':
      return {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: chunk.text },
      }
    case 'todo_update':
      return {
        sessionUpdate: 'plan',
        entries: chunk.todos
          // ACP plans have no cancelled state; a cancelled todo is simply no
          // longer part of the plan (each update replaces the whole list).
          .filter(
            (todo): todo is TodoItem & { status: PlanEntry['status'] } =>
              todo.status !== 'cancelled',
          )
          .map(
            (todo): PlanEntry => ({
              content: todo.content,
              priority: 'medium',
              status: todo.status,
            }),
          ),
      }
    case 'tool_call':
      return {
        sessionUpdate: 'tool_call',
        toolCallId: chunk.toolCall.id,
        title: chunk.toolCall.name,
        kind: 'other',
        status: 'pending',
        rawInput: chunk.toolCall.args,
      }
    case 'tool_result':
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: chunk.toolCallId,
        status: chunk.isError ? 'failed' : 'completed',
        content: [{ type: 'content', content: { type: 'text', text: chunk.result } }],
      }
    default:
      return null
  }
}

export function sessionUpdateToStreamChunk(update: SessionUpdate): StreamChunk | null {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return update.content.type === 'text' ? { type: 'text', text: update.content.text } : null
    // Reasoning renders in the "Thinking" disclosure and — unlike `text` — never
    // joins the assistant's answer, thread history, or the next turn's replayed
    // transcript (buildAcpPrompt).
    case 'agent_thought_chunk':
      return update.content.type === 'text'
        ? { type: 'reasoning', text: update.content.text }
        : null
    // ACP plan entries carry no ids and each update replaces the whole plan, so
    // index-based ids keep items stable across updates for the todo UI.
    case 'plan':
      return {
        type: 'todo_update',
        todos: update.entries.map(
          (entry, index): TodoItem => ({
            id: `acp-plan-${String(index + 1)}`,
            content: entry.content,
            status: entry.status,
          }),
        ),
      }
    case 'tool_call':
      return {
        type: 'tool_call',
        toolCall: {
          id: update.toolCallId,
          name: unwrapInlineCode(update.title),
          args: update.rawInput ?? {},
        },
      }
    case 'tool_call_update': {
      // Only surface terminal states; intermediate progress has no chunk.
      if (update.status !== 'completed' && update.status !== 'failed') return null
      return {
        type: 'tool_result',
        toolCallId: update.toolCallId,
        result: toolCallContentText(update.content),
        isError: update.status === 'failed',
      }
    }
    default:
      return null
  }
}

/**
 * Strip surrounding Markdown code punctuation from a string. External ACP agents
 * (Cursor, Claude Code) send tool-call titles as inline code — e.g.
 * `` `git diff --stat` `` or a fenced block — which renders as literal backticks
 * in Copse's plain-text tool cards and approval prompts. We unwrap a balanced
 * leading/trailing backtick run (or a ```` ``` ```` fence) but leave titles with
 * only mid-string code (`run `x` now`) untouched.
 */
export function unwrapInlineCode(text: string): string {
  const trimmed = text.trim()
  const fenced = /^`{3,}[^\n]*\n([\s\S]*?)\n?`{3,}$/.exec(trimmed)
  if (fenced?.[1] !== undefined) return fenced[1].trim()
  const inline = /^(`+)([\s\S]+?)\1$/.exec(trimmed)
  if (inline?.[2] !== undefined && inline[2].trim().length > 0) return inline[2].trim()
  return trimmed
}

/** Collect the plain text from a tool call's content blocks. */
function toolCallContentText(content: ToolCallContent[] | null | undefined): string {
  if (!content) return ''
  const parts: string[] = []
  for (const item of content) {
    if (item.type === 'content' && item.content.type === 'text') parts.push(item.content.text)
  }
  return parts.join('')
}
