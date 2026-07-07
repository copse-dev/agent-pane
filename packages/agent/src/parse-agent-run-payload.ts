import type { UserContent } from '@copse/llm/wire-types.ts'
import type { AgentRunPayload, TodoItem } from './wire-types.ts'

export function parseAgentRunPayload(rawPrompt: string): {
  userContent: UserContent
  invokedSkills: string[]
  priorTodos: TodoItem[]
  workingBrief?: string
  model?: string
} {
  try {
    const parsed = JSON.parse(rawPrompt) as AgentRunPayload | UserContent
    if (parsed && typeof parsed === 'object' && 'content' in parsed) {
      const payload = parsed
      return {
        userContent: payload.content,
        invokedSkills: payload.invokedSkills ?? [],
        priorTodos: payload.priorTodos ?? [],
        ...(payload.workingBrief !== undefined ? { workingBrief: payload.workingBrief } : {}),
        ...(typeof payload.model === 'string' && payload.model ? { model: payload.model } : {}),
      }
    }
    return { userContent: parsed, invokedSkills: [], priorTodos: [] }
  } catch {
    return { userContent: rawPrompt, invokedSkills: [], priorTodos: [] }
  }
}
