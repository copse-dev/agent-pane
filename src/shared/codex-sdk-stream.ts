import type { StreamChunk } from './types/index.ts'

/**
 * Maps the JSONL events emitted by the `@openai/codex-sdk` Thread stream onto the
 * app's StreamChunk shape so a Codex turn renders in the transcript exactly like
 * a local or remote-agent turn. Kept free of any SDK / node imports (the shapes
 * below mirror the SDK's `ThreadEvent` / `ThreadItem` types) so this stays a pure,
 * renderer-safe module that unit-tests without spawning the Codex CLI.
 *
 * Events are mapped on `item.completed` (the terminal state for an item), so each
 * tool-like item yields its call and result together and the assistant/reasoning
 * text arrives whole — Codex reports items, not token deltas, over this stream.
 */

interface CodexUsage {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
}

interface CodexThreadItem {
  id?: string
  type?: string
  // agent_message / reasoning / error
  text?: string
  message?: string
  // command_execution
  command?: string
  aggregated_output?: string
  exit_code?: number
  status?: string
  // file_change
  changes?: Array<{ path?: string; kind?: string }>
  // mcp_tool_call
  server?: string
  tool?: string
  arguments?: unknown
  result?: unknown
  error?: { message?: string }
  // web_search
  query?: string
}

interface CodexThreadEvent {
  type?: string
  thread_id?: string
  usage?: CodexUsage
  item?: CodexThreadItem
  error?: { message?: string }
  message?: string
}

export interface CodexSdkStreamState {
  assistantText: string
  /** Item ids already surfaced as a tool call, so a repeat doesn't re-emit. */
  seenToolCalls: Set<string>
  /** Captured from the `thread.started` event, for resuming the thread later. */
  threadId: string | null
  usage: CodexUsage | null
  terminalStatus: string | null
  done: boolean
}

export function createCodexSdkStreamState(): CodexSdkStreamState {
  return {
    assistantText: '',
    seenToolCalls: new Set(),
    threadId: null,
    usage: null,
    terminalStatus: null,
    done: false,
  }
}

function formatJson(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function commandFailed(item: CodexThreadItem): boolean {
  return item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0)
}

function summarizeFileChanges(changes: CodexThreadItem['changes']): string {
  if (!changes?.length) return 'No file changes.'
  return changes
    .filter((c): c is { path: string; kind?: string } => typeof c.path === 'string')
    .map((c) => `${c.kind ?? 'update'} ${c.path}`)
    .join('\n')
}

function toolCallChunks(
  state: CodexSdkStreamState,
  id: string,
  name: string,
  args: unknown,
  result: { text: string; isError: boolean },
): StreamChunk[] {
  const chunks: StreamChunk[] = []
  if (!state.seenToolCalls.has(id)) {
    state.seenToolCalls.add(id)
    chunks.push({ type: 'tool_call', toolCall: { id, name, args: args ?? {} } })
  }
  chunks.push({
    type: 'tool_result',
    toolCallId: id,
    result: result.text,
    isError: result.isError,
  })
  return chunks
}

function itemToChunks(item: CodexThreadItem, state: CodexSdkStreamState): StreamChunk[] {
  const id = item.id ?? ''

  switch (item.type) {
    case 'agent_message': {
      const text = item.text ?? ''
      if (!text) return []
      state.assistantText += text
      return [{ type: 'text', text }]
    }
    case 'reasoning': {
      const text = item.text ?? ''
      return text ? [{ type: 'reasoning', text }] : []
    }
    case 'command_execution': {
      if (!id) return []
      const exit = typeof item.exit_code === 'number' ? `\n[exit ${String(item.exit_code)}]` : ''
      return toolCallChunks(
        state,
        id,
        'shell',
        { command: item.command ?? '' },
        {
          text: `${item.aggregated_output ?? ''}${exit}`,
          isError: commandFailed(item),
        },
      )
    }
    case 'file_change': {
      if (!id) return []
      return toolCallChunks(
        state,
        id,
        'apply_patch',
        { changes: item.changes ?? [] },
        {
          text: summarizeFileChanges(item.changes),
          isError: item.status === 'failed',
        },
      )
    }
    case 'mcp_tool_call': {
      if (!id) return []
      const name = `${item.server ?? 'mcp'}/${item.tool ?? 'tool'}`
      const isError = !!item.error || item.status === 'failed'
      return toolCallChunks(state, id, name, item.arguments, {
        text: item.error?.message ?? formatJson(item.result),
        isError,
      })
    }
    case 'web_search': {
      if (!id) return []
      return toolCallChunks(
        state,
        id,
        'web_search',
        { query: item.query ?? '' },
        {
          text: '',
          isError: false,
        },
      )
    }
    case 'error': {
      const message = item.message ?? 'unknown error'
      return [{ type: 'text', text: `\n\n> Codex reported an error: ${message}\n` }]
    }
    // todo_list and any future item types are not surfaced in the transcript.
    default:
      return []
  }
}

/**
 * Map a single Codex Thread event to renderer chunks, mutating `state` to track
 * accumulated text, seen tool calls, the thread id, and usage. Throws on the
 * terminal `turn.failed` / `error` events so the caller classifies them like any
 * other run failure.
 */
export function codexSdkEventToChunks(
  event: CodexThreadEvent,
  state: CodexSdkStreamState,
): StreamChunk[] {
  switch (event.type) {
    case 'thread.started':
      if (event.thread_id) state.threadId = event.thread_id
      return []
    case 'item.completed':
      return event.item ? itemToChunks(event.item, state) : []
    case 'turn.completed':
      state.usage = event.usage ?? null
      state.terminalStatus = 'completed'
      state.done = true
      return []
    case 'turn.failed':
      state.done = true
      throw new Error(`Codex turn failed: ${event.error?.message ?? 'unknown error'}`)
    case 'error':
      state.done = true
      throw new Error(`Codex stream error: ${event.message ?? 'unknown error'}`)
    // turn.started, item.started, item.updated are not surfaced (item.completed
    // carries the terminal payload we render).
    default:
      return []
  }
}
