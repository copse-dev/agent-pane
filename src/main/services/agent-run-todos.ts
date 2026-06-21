import type { TodoItem } from '@shared/types/todo.ts'

let activeTodos: TodoItem[] = []
let onUpdate: ((todos: TodoItem[]) => void) | null = null

export function setAgentRunTodoContext(
  ctx: {
    initial: TodoItem[]
    onUpdate: (todos: TodoItem[]) => void
  } | null,
): void {
  if (!ctx) {
    activeTodos = []
    onUpdate = null
    return
  }
  activeTodos = [...ctx.initial]
  onUpdate = ctx.onUpdate
}

export function getAgentRunTodos(): TodoItem[] {
  return activeTodos
}

export function setAgentRunTodos(todos: TodoItem[]): void {
  activeTodos = todos
  onUpdate?.(todos)
}

export function clearAgentRunTodos(): void {
  activeTodos = []
  onUpdate = null
}
