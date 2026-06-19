export type UserContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image'; dataUrl: string }>

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
