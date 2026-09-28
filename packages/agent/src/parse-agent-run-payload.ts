import type { UserContent } from '@copse/llm/wire-types.ts'
import { isReasoningLevel, type ReasoningLevel } from '@copse/llm/model-parameters.ts'
import type { TodoItem } from './wire-types.ts'
import { z } from 'zod'
import { isRecord } from '@copse/std/unknown-value.ts'

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
  priority: z.enum(['high', 'medium', 'low']).optional(),
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

/**
 * Ceiling on the review summary a payload may carry. The renderer already
 * keeps it compact (summary and findings, a few reports at most); this only
 * bounds what one prompt can add to the thread's history.
 */
export const REVIEW_CONTEXT_CHAR_CAP = 20_000

function parseReviewContext(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return value.length <= REVIEW_CONTEXT_CHAR_CAP
    ? value
    : `${value.slice(0, REVIEW_CONTEXT_CHAR_CAP)}\n[review summary truncated]`
}

export function parseAgentRunPayload(rawPrompt: string): {
  userContent: UserContent
  invokedSkills: string[]
  /** Subagent the user invoked with `/name` this turn, if any. */
  invokedAgent?: string
  priorTodos: TodoItem[]
  workingBrief?: string
  model?: string
  /** Per-chat reasoning dial, overriding the level saved on the model. */
  reasoning?: ReasoningLevel
  turnTreeId?: string
  continuationBudgetUsed?: number
  /** Summary of reviews the user ran since the model's last reply, capped. */
  reviewContext?: string
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
      const reviewContext = parseReviewContext(parsed['reviewContext'])
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
        ...(typeof parsed['invokedAgent'] === 'string' && parsed['invokedAgent']
          ? { invokedAgent: parsed['invokedAgent'] }
          : {}),
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
        ...(reviewContext !== undefined ? { reviewContext } : {}),
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
