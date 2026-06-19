export type ThreadStatus = 'idle' | 'running' | 'error'

export interface ContextTrimRecord {
  at: number
  contextWindow: number
  historyBudget: number
  estimatedTokens: number
}

export interface Thread {
  id: string
  title: string
  status: ThreadStatus
  messages: Message[]
  usage: ThreadUsage
  /** Populated when history compaction runs during an agent turn (also in JSONL export). */
  contextTrims?: ContextTrimRecord[]
  createdAt: number
  updatedAt: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'error'
  content: string // accumulated text (appended during streaming)
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

export interface ThreadUsage {
  inputTokens: number
  outputTokens: number
}
