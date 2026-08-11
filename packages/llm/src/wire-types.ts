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
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image'; dataUrl: string; detail?: ImageDetail }>

/**
 * How much fidelity a provider should spend on one image.
 *
 * `low` downsamples to a fixed small budget — far cheaper, and enough for a
 * screenshot you only need the gist of, but too coarse to read text in. `high`
 * pays for full detail. `auto` leaves the choice to the provider, which is what
 * Copse has always done and remains the default when a part carries no value.
 *
 * Carried per image rather than per provider on purpose: fidelity is a property
 * of the picture, not the endpoint. A pasted stack trace and a batch of video
 * frames can travel in the same request and want opposite answers, so one
 * setting covering both would be wrong for one of them whichever way it is set.
 */
export const IMAGE_DETAILS = ['auto', 'low', 'high'] as const

export type ImageDetail = (typeof IMAGE_DETAILS)[number]

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

/**
 * An image a tool produced as part of its result (e.g. `video_frames` stills).
 * `name` is a short label — a frame's timestamped filename — so the model can
 * refer to a specific image by name in its reply and in follow-up tool calls.
 */
export interface ToolResultImage {
  dataUrl: string
  name?: string
}

export interface ToolResult {
  toolCallId: string
  result: string
  /**
   * Images to show the model alongside `result`. Anthropic accepts image blocks
   * directly inside a `tool_result`; the OpenAI-shaped providers do not, so they
   * follow the tool message with a user message carrying the images (see
   * `toolResultImageFollowUp`). Either way `result` alone must still describe
   * what was found — a provider or a trimmed history may drop the images.
   */
  images?: ToolResultImage[]
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
      /**
       * When set, the usage ledger records this source instead of `'agent'`.
       * Used for the dedicated advisor cost line (issue #566).
       */
      usageSource?: 'advisor'
    }
  /**
   * Progress while a local model processes the prompt before its first output
   * token. `fraction` is a provider-reported value from 0 to 1.
   */
  | { type: 'prompt_progress'; fraction: number }
  | { type: 'done'; stopReason?: string }

// ── The provider contract ────────────────────────────────────────────────────

export interface LLMProvider {
  stream(
    messages: LLMMessage[],
    tools: LLMTool[],
    signal?: AbortSignal,
  ): AsyncIterable<ProviderStreamChunk>
}
