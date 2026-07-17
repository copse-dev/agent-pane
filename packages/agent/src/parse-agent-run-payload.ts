import type { UserContent } from '@copse/llm/wire-types.ts'
import type { AgentRunPayload, TodoItem } from './wire-types.ts'

export function parseAgentRunPayload(rawPrompt: string): {
  userContent: UserContent
  invokedSkills: string[]
  priorTodos: TodoItem[]
  workingBrief?: string
  model?: string
  turnTreeId?: string
  continuationBudgetUsed?: number
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
        ...(typeof payload.turnTreeId === 'string' && payload.turnTreeId
          ? { turnTreeId: payload.turnTreeId }
          : {}),
        ...(typeof payload.continuationBudgetUsed === 'number' &&
        Number.isFinite(payload.continuationBudgetUsed)
          ? { continuationBudgetUsed: payload.continuationBudgetUsed }
          : {}),
      }
    }
    return { userContent: parsed, invokedSkills: [], priorTodos: [] }
  } catch {
    return { userContent: rawPrompt, invokedSkills: [], priorTodos: [] }
  }
}
