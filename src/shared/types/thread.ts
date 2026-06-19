export type ThreadStatus = 'idle' | 'running' | 'error'

export interface Thread {
  id: string
  title: string
  status: ThreadStatus
  messages: Message[]
  usage: ThreadUsage
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

export interface ToolCall {
  id: string
  name: string
  args: unknown
  status: 'running' | 'done' | 'error'
  result: string | null
}

export interface ThreadUsage {
  inputTokens: number
  outputTokens: number
}
