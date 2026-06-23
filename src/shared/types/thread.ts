import type { AgentRunPayload } from './skills.ts'
import type { TodoItem } from './todo.ts'

export type ThreadStatus = 'idle' | 'running' | 'error'

/** User message waiting for the current agent run to finish. */
export interface QueuedUserMessage {
  messageId: string
  payload: AgentRunPayload
  createdAt: number
}

export interface ContextTrimRecord {
  at: number
  contextWindow: number
  historyBudget: number
  estimatedTokens: number
}

/** Live context fill snapshot (updated during an agent run). */
export interface ContextSnapshot {
  contextWindow: number
  conversationBudget: number
  conversationTokens: number
  fillRatio: number
  updatedAt: number
}

/** Which part of the assembled prompt a breakdown segment represents. */
export type ContextSegmentKey = 'system' | 'tools' | 'mcp' | 'skills' | 'history' | 'message'

/** One slice of the pre-send context estimate (e.g. system prompt, tools, your message). */
export interface ContextBreakdownSegment {
  key: ContextSegmentKey
  label: string
  tokens: number
}

/**
 * Estimated token cost of everything that would be sent on the next prompt,
 * split into named parts. Computed before sending so the composer can show
 * what the default context costs and how the draft message adds to it.
 */
export interface ContextBreakdown {
  segments: ContextBreakdownSegment[]
  totalTokens: number
  contextWindow: number
}

export interface Thread {
  id: string
  title: string
  status: ThreadStatus
  messages: Message[]
  usage: ThreadUsage
  /** Populated when history compaction runs during an agent turn (also in JSONL export). */
  contextTrims?: ContextTrimRecord[]
  /** Latest context fill estimate while the agent is running (or after the last run). */
  contextSnapshot?: ContextSnapshot
  /** Structured task plan for multi-step agent work (updated via update_todos). */
  todos?: TodoItem[]
  /** Persisted parent/explore goal; set on the first user message in the thread. */
  workingBrief?: string
  /** Git branch this thread was started on; set on first message and persisted. */
  gitBranch?: string
  /** Prompts submitted while the agent is running; drained FIFO when idle. */
  pendingMessages?: QueuedUserMessage[]
  /** True while a queued message is being edited; suspends FIFO draining. */
  queuePaused?: boolean
  /** Unsubmitted composer text; keeps blank threads visible across switches. */
  draftPrompt?: string
  createdAt: number
  updatedAt: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'error'
  content: string // accumulated text (appended during streaming)
  /** Pasted image attachments as data URLs (user messages only). */
  images?: string[]
  toolCalls: ToolCall[]
  createdAt: number
}

export interface SubagentSession {
  id: string
  kind: 'explore' | 'investigate_ci'
  status: 'running' | 'done' | 'error'
  prompt: string
  summary: string | null
  messages: SubagentMessage[]
  /** Token totals for this subagent's own loop (also folded into the parent thread total). */
  usage?: ModelUsage
}

export interface SubagentMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolCalls: ToolCall[]
  /** Wall-clock time the message was first created; absent on sessions persisted before timestamps existed. */
  createdAt?: number
}

export interface ToolCall {
  id: string
  name: string
  args: unknown
  status: 'running' | 'done' | 'error'
  result: string | null
  subagent?: SubagentSession
}

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

export interface UsageDelta extends ModelUsage {
  model: string
}
