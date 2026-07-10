// The todo item itself is owned by the agent module (it crosses the loop
// contract via `AgentRunPayload.priorTodos` and the finalize gate); re-exported
// here so `@shared/types` consumers are unchanged.
export type {
  TodoStatus,
  TodoCheck,
  TodoAssignedModel,
  TodoItem,
  TodoUpdateInput,
} from '@copse/agent/wire-types.ts'
