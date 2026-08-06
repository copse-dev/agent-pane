import type { UserContent } from '@copse/llm/wire-types.ts'
import { isReasoningLevel, type ReasoningLevel } from '@copse/llm/model-parameters.ts'
import type { TodoItem } from './wire-types.ts'
import { z } from 'zod'
import { isRecord } from './internal-utils.ts'

const userContentSchema = z.union([
  z.string(),
  z.array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({ type: z.literal('image'), dataUrl: z.string() }),
    ]),
  ),
])

const todoSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
  check: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('shell'),
        command: z.string(),
        expectExit: z.number().optional(),
      }),
      z.object({ kind: z.literal('fileExists'), path: z.string() }),
      z.object({ kind: z.literal('typecheck') }),
    ])
    .optional(),
  assignedModel: z.enum(['cloud', 'local']).optional(),
})

export function parseAgentRunPayload(rawPrompt: string): {
  userContent: UserContent
  invokedSkills: string[]
  priorTodos: TodoItem[]
  workingBrief?: string
  model?: string
  /** Per-chat reasoning dial, overriding the level saved on the model. */
  reasoning?: ReasoningLevel
  turnTreeId?: string
  continuationBudgetUsed?: number
} {
  try {
    const parsed: unknown = JSON.parse(rawPrompt)
    if (isRecord(parsed) && 'content' in parsed) {
      const content = userContentSchema.safeParse(parsed['content'])
      if (!content.success) {
        return { userContent: rawPrompt, invokedSkills: [], priorTodos: [] }
      }
      const invokedSkills = z.array(z.string()).safeParse(parsed['invokedSkills'])
      const priorTodos = z.array(todoSchema).safeParse(parsed['priorTodos'])
      const normalizedTodos: TodoItem[] = priorTodos.success
        ? priorTodos.data.map((todo) => ({
            id: todo.id,
            content: todo.content,
            status: todo.status,
            ...(todo.check !== undefined ? { check: todo.check } : {}),
            ...(todo.assignedModel !== undefined ? { assignedModel: todo.assignedModel } : {}),
          }))
        : []
      return {
        userContent: content.data,
        invokedSkills: invokedSkills.success ? invokedSkills.data : [],
        priorTodos: normalizedTodos,
        ...(typeof parsed['workingBrief'] === 'string'
          ? { workingBrief: parsed['workingBrief'] }
          : {}),
        ...(typeof parsed['model'] === 'string' && parsed['model']
          ? { model: parsed['model'] }
          : {}),
        ...(isReasoningLevel(parsed['reasoning']) ? { reasoning: parsed['reasoning'] } : {}),
        ...(typeof parsed['turnTreeId'] === 'string' && parsed['turnTreeId']
          ? { turnTreeId: parsed['turnTreeId'] }
          : {}),
        ...(typeof parsed['continuationBudgetUsed'] === 'number' &&
        Number.isFinite(parsed['continuationBudgetUsed'])
          ? { continuationBudgetUsed: parsed['continuationBudgetUsed'] }
          : {}),
      }
    }
    const content = userContentSchema.safeParse(parsed)
    return {
      userContent: content.success ? content.data : rawPrompt,
      invokedSkills: [],
      priorTodos: [],
    }
  } catch {
    return { userContent: rawPrompt, invokedSkills: [], priorTodos: [] }
  }
}
