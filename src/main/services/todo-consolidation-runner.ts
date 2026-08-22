import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Context for the `consolidate_todo_workers` tool (phase 3,
 * docs/plans/parallel-todo-workers.md). Installed by agent-service only while
 * worker merges are pending, so the tool is inert — and reports itself as such
 * — outside an active consolidation.
 */
export interface TodoConsolidationRunnerContext {
  /** Ordered todo ids whose worker branches still need merging. */
  pendingTodoIds: readonly string[]
  projectRoot: string
  /**
   * Run one consolidate-or-discard round. Returns the report text routed to the
   * parent through the tool-result channel, plus whether everything merged.
   */
  run: (discard: readonly string[]) => Promise<{ message: string; clean: boolean }>
}

const contextStorage = new AsyncLocalStorage<TodoConsolidationRunnerContext>()

export function runWithTodoConsolidationContext<T>(
  ctx: TodoConsolidationRunnerContext,
  fn: () => Promise<T>,
): Promise<T> {
  return contextStorage.run(ctx, fn)
}

export function getTodoConsolidationRunner():
  ((discard: readonly string[]) => Promise<string>) | null {
  const ctx = contextStorage.getStore()
  if (!ctx) return null
  return async (discard) => {
    const result = await ctx.run(discard)
    return result.message
  }
}

/** Pending todo ids for the active consolidation, if any. */
export function getPendingConsolidationTodoIds(): readonly string[] {
  return contextStorage.getStore()?.pendingTodoIds ?? []
}
