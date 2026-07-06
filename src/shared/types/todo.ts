// The todo item itself is owned by the agent module (it crosses the loop
// contract via `AgentRunPayload.priorTodos` and the finalize gate); re-exported
// here so `@shared/types` consumers are unchanged.
import type { TodoStatus, TodoCheck, TodoAssignedModel } from '@copse/agent/wire-types.ts'
export type { TodoStatus, TodoCheck, TodoAssignedModel, TodoItem } from '@copse/agent/wire-types.ts'

export interface TodoUpdateInput {
  id?: string | undefined
  content: string
  status: TodoStatus
  check?: TodoCheck | undefined
  assignedModel?: TodoAssignedModel | undefined
}
