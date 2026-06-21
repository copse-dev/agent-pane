import type { UserContent } from '@shared/types'
import type { AgentRunPayload } from '@shared/types/skills.ts'
import type { TodoItem } from '@shared/types/todo.ts'

export function parseAgentRunPayload(rawPrompt: string): {
  userContent: UserContent
  invokedSkills: string[]
  priorTodos: TodoItem[]
  workingBrief?: string
} {
  try {
    const parsed = JSON.parse(rawPrompt) as AgentRunPayload | UserContent
    if (parsed && typeof parsed === 'object' && 'content' in parsed) {
      const payload = parsed as AgentRunPayload
      return {
        userContent: payload.content,
        invokedSkills: payload.invokedSkills ?? [],
        priorTodos: payload.priorTodos ?? [],
        ...(payload.workingBrief !== undefined ? { workingBrief: payload.workingBrief } : {}),
      }
    }
    return { userContent: parsed as UserContent, invokedSkills: [], priorTodos: [] }
  } catch {
    return { userContent: rawPrompt, invokedSkills: [], priorTodos: [] }
  }
}
