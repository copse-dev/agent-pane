import { AsyncLocalStorage } from 'node:async_hooks'
import type { TodoItem } from '@shared/types/todo.ts'

/**
 * Post-process hook for `update_todos` (local worker routing, compaction).
 * Lives on the same ALS store as the plan so concurrent runs cannot steal each
 * other's callback — a process-global slot would hand one thread's sendChunk /
 * worker route to a sibling (same defect class as explore/advisor contexts).
 */
export type TodoToolPostProcess = (
  before: TodoItem[],
  after: TodoItem[],
) => Promise<{ todos: TodoItem[]; extraMessage?: string }>

interface AgentRunTodoStore {
  todos: TodoItem[]
  onUpdate: (todos: TodoItem[]) => void
  postProcess: TodoToolPostProcess | null
}

/**
 * Per-run todo state. Must not be a module-global slot: the dispatcher allows
 * concurrent turns on different threads in the same project, and a single cell
 * lets one run's `update_todos` patch (and stream) another's plan.
 */
const storage = new AsyncLocalStorage<AgentRunTodoStore>()

export function runWithAgentRunTodoContext<T>(
  ctx: {
    initial: TodoItem[]
    onUpdate: (todos: TodoItem[]) => void
    postProcess?: TodoToolPostProcess | null
  },
  fn: () => T,
): T {
  return storage.run(
    {
      todos: [...ctx.initial],
      onUpdate: ctx.onUpdate,
      postProcess: ctx.postProcess ?? null,
    },
    fn,
  )
}

function requireStore(): AgentRunTodoStore {
  const store = storage.getStore()
  if (!store) throw new Error('No agent-run todo context is active')
  return store
}

export function getAgentRunTodos(): TodoItem[] {
  return storage.getStore()?.todos ?? []
}

export function setAgentRunTodos(todos: TodoItem[]): void {
  const store = requireStore()
  store.todos = todos
  store.onUpdate(todos)
}

export function getTodoToolPostProcess(): TodoToolPostProcess | null {
  return storage.getStore()?.postProcess ?? null
}
