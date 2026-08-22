import { z } from 'zod'
import { defineTool } from '@shared/types'
import type { TodoItem, TodoUpdateInput } from '@shared/types/todo.ts'
import {
  applyTodoUpdate,
  gateCompletedStatus,
  findNewlyInProgressLocal,
  findNewlyInProgressLocalSet,
  findNewlyCompleted,
} from '@shared/todos/todo-logic.ts'
import {
  getAgentRunTodos,
  getTodoToolPostProcess,
  setAgentRunTodos,
  type TodoToolPostProcess,
} from '../services/agent-run-todos.ts'
import { verifyTodoCheck } from '../services/todo-verification.ts'

const todoCheckSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('shell'),
    command: z.string(),
    expectExit: z.number().optional(),
  }),
  z.object({ kind: z.literal('fileExists'), path: z.string() }),
  z.object({ kind: z.literal('typecheck') }),
])

const todoInputSchema = z.object({
  id: z.string().optional(),
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
  check: todoCheckSchema.optional(),
  assignedModel: z.enum(['cloud', 'local']).optional(),
  parallel: z
    .boolean()
    .optional()
    .describe(
      'Records that the item is independent groundwork for a future parallel-worker rollout. It does not change execution in this build; continue marking only one item in progress at a time.',
    ),
})

export type { TodoToolPostProcess }

async function applyAndGate(
  incoming: TodoUpdateInput[],
  merge: boolean,
  signal: AbortSignal,
): Promise<{ todos: TodoItem[]; messages: string[] }> {
  const before = getAgentRunTodos()
  let todos = applyTodoUpdate(before, incoming, merge)
  const messages: string[] = []

  todos = await Promise.all(
    todos.map(async (item) => {
      if (item.status !== 'completed' || !item.check) return item
      const result = await verifyTodoCheck(item.check, signal)
      const gated = gateCompletedStatus(item, result.passed)
      if (gated.message) messages.push(`${item.content}: ${gated.message} (${result.detail})`)
      return { ...item, status: gated.status }
    }),
  )

  const postProcess = getTodoToolPostProcess()
  if (postProcess) {
    const result = await postProcess(before, todos)
    todos = result.todos
    if (result.extraMessage) messages.push(result.extraMessage)
  }

  setAgentRunTodos(todos)
  return { todos, messages }
}

export const updateTodosTool = defineTool({
  name: 'update_todos',
  description:
    'Create or update the structured task plan. Pass the full list (merge=false) or patch items by id (merge=true). Use for multi-step work only; mark one item in_progress at a time.',
  parameters: z.object({
    todos: z.array(todoInputSchema).min(1),
    merge: z.boolean().optional().describe('When true, merge by id into the existing plan'),
  }),
  async execute({ todos, merge }, signal) {
    const { todos: updated, messages } = await applyAndGate(todos, merge ?? false, signal)
    const progress = updated.filter((t) => t.status !== 'cancelled')
    const done = progress.filter((t) => t.status === 'completed').length
    const lines = [
      `Plan updated (${String(done)}/${String(progress.length)} done).`,
      ...updated.map((t) => `- [${t.status}] ${t.content}`),
    ]
    if (messages.length) lines.push('', ...messages)
    return lines.join('\n')
  },
})

export {
  findNewlyInProgressLocal,
  findNewlyInProgressLocalSet,
  findNewlyCompleted,
  applyTodoUpdate,
}
