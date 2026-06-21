import type { TodoItem } from './todo.ts'

export type ThreadStatus = 'idle' | 'running' | 'error'

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
  kind: 'explore'
  status: 'running' | 'done' | 'error'
  prompt: string
  summary: string | null
  messages: SubagentMessage[]
  usage?: { inputTokens: number; outputTokens: number }
}

export interface SubagentMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolCalls: ToolCall[]
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
}

export interface ThreadUsage {
  inputTokens: number
  outputTokens: number
  /** Token totals keyed by model id (e.g. claude-sonnet-4-6, lmstudio:qwen). */
  byModel?: Record<string, ModelUsage>
}

export interface UsageDelta extends ModelUsage {
  model: string
}
