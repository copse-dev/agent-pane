// Wire types owned by the LLM module — the provider contract and the values that
// cross it. These are the types that must travel with the module when it is
// extracted to `@copse/llm`, so they live here (not in the app-wide
// `@shared/types` barrel) and depend on nothing app-specific.
//
// `@shared/types` re-exports every name below, so app code keeps importing these
// from `@shared/types` unchanged; this file is the single source of truth and
// the app barrel is now a thin consumer of the module (app → package, the
// direction extraction needs). See ./README-less note in packages/llm/README.md.

// ── Messages sent to a provider ──────────────────────────────────────────────

export type UserContent =
  string | Array<{ type: 'text'; text: string } | { type: 'image'; dataUrl: string }>

export type LLMMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: UserContent }
  | { role: 'assistant'; content: string | ToolCallContent[] }
  | { role: 'tool'; toolResults: ToolResult[] }

export interface ToolCallContent {
  id: string
  name: string
  args: unknown
}

export interface ToolResult {
  toolCallId: string
  result: string
}

/** A tool exposed to the model. `parameters` is a JSON Schema object. */
export interface LLMTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

// ── Token usage reported back by a provider ──────────────────────────────────

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  /**
   * Portion of `inputTokens` served from the provider prompt cache (Anthropic
   * `cache_read_input_tokens`). Billed far cheaper than fresh input; absent for
   * providers/usage that don't report cache stats.
   */
  cacheReadTokens?: number
  /**
   * Portion of `inputTokens` written to the provider prompt cache (Anthropic
   * `cache_creation_input_tokens`).
   */
  cacheCreationTokens?: number
}

export interface ThreadUsage {
  inputTokens: number
  outputTokens: number
  /** Cumulative cache-read tokens across the thread (subset of `inputTokens`). */
  cacheReadTokens?: number
  /** Cumulative cache-creation tokens across the thread (subset of `inputTokens`). */
  cacheCreationTokens?: number
  /** Token totals keyed by model id (e.g. claude-sonnet-4-6, lmstudio:qwen). */
  byModel?: Record<string, ModelUsage>
}

// ── The provider output stream ───────────────────────────────────────────────

export interface ToolCallChunk {
  id: string
  name: string
  args: unknown
  /**
   * Set when the provider could not parse the tool-call arguments JSON (e.g. a
   * truncated or malformed streamed tool call). When present, `args` is not
   * trustworthy and the agent loop must surface an error tool result instead of
   * executing the tool with empty/partial args.
   */
  argsError?: string
  /**
   * ACP tool-call `kind` (e.g. `'execute'`, `'read'`, `'search'`), carried from
   * an external ACP agent so the UI can recognise its shell/terminal commands
   * (`'execute'`) even though they don't use the built-in `run_shell` tool.
   * Absent for the built-in agent loop.
   */
  kind?: string
}

/**
 * The chunks a provider's `stream()` may yield. This is the narrow contract the
 * `@copse/llm` package owns. The app's fat `StreamChunk` (see
 * `@shared/types/stream.ts`) is a superset that adds agent-loop/orchestration
 * events (subagent_*, todo_*, context_*, model_comparison, …) which providers
 * never emit — so a provider stream is always assignable to the app's sink.
 */
export type ProviderStreamChunk =
  | { type: 'text'; text: string }
  /**
   * Incremental reasoning / "thinking" text the model emits before (or alongside)
   * its answer. Carried separately from `text` so it never lands in the
   * assistant's answer or the conversation history sent upstream.
   */
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; toolCall: ToolCallChunk }
  | {
      type: 'tool_result'
      toolCallId: string
      result: string
      isError: boolean
      editStats?: { additions: number; deletions: number }
      /**
       * `'markdown'` when `result` is agent-authored Markdown (ACP tool output)
       * and should render through the Markdown pipeline rather than a raw `<pre>`.
       */
      resultFormat?: 'markdown'
    }
  | {
      type: 'usage'
      model: string
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
      cacheCreationTokens?: number
      /** Token counts are a local ~4 chars/token estimate, not agent-reported. */
      estimated?: boolean
    }
  | { type: 'done'; stopReason?: string }

// ── The provider contract ────────────────────────────────────────────────────

export interface LLMProvider {
  stream(
    messages: LLMMessage[],
    tools: LLMTool[],
    signal?: AbortSignal,
  ): AsyncIterable<ProviderStreamChunk>
}
