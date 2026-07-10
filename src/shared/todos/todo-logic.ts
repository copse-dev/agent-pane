import type { TodoItem, TodoStatus, TodoUpdateInput } from '@shared/types/todo.ts'

const randomUUID = (): string => globalThis.crypto.randomUUID()

export function todoProgress(todos: readonly TodoItem[]): { done: number; total: number } {
  const active = todos.filter((t) => t.status !== 'cancelled')
  const done = active.filter((t) => t.status === 'completed').length
  return { done, total: active.length }
}

export function formatTodoProgress(todos: readonly TodoItem[]): string | null {
  const { done, total } = todoProgress(todos)
  if (total === 0) return null
  return `${String(done)}/${String(total)} done`
}

/** Light steering: multi-step work that benefits from an explicit plan. */
export function shouldSteerTodos(userMessage: string): boolean {
  const text = userMessage.trim().toLowerCase()
  if (text.length < 20) return false
  const multiStep =
    /\b(then|after that|also|step \d|first.*second|implement.*test|refactor.*across)\b/.test(text)
  const complex =
    /\b(refactor|migrate|implement|add.*and.*test|fix.*across|multi-file|several files)\b/.test(
      text,
    )
  const audit = /\b(deep[- ]?dive|reviewing|review)\b/.test(text)
  return multiStep || complex || audit
}

export function formatTodosForPrompt(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return ''
  const lines = todos.map((t) => {
    const model = t.assignedModel ? ` [${t.assignedModel}]` : ''
    const check = t.check ? ` (check: ${t.check.kind})` : ''
    return `- [${t.status}] ${t.content}${model}${check} (id: ${t.id})`
  })
  return `\n\n## Current plan\n${lines.join('\n')}`
}

export function applyTodoUpdate(
  current: readonly TodoItem[],
  incoming: readonly TodoUpdateInput[],
  merge: boolean,
): TodoItem[] {
  const byId = new Map<string, TodoItem>()
  if (merge) {
    for (const t of current) byId.set(t.id, { ...t })
  }
  for (const raw of incoming) {
    const id = raw.id?.trim() || randomUUID()
    const prev = byId.get(id)
    byId.set(id, {
      id,
      content: raw.content,
      status: raw.status,
      ...(raw.check !== undefined
        ? { check: raw.check }
        : prev?.check
          ? { check: prev.check }
          : {}),
      ...(raw.assignedModel !== undefined
        ? { assignedModel: raw.assignedModel }
        : prev?.assignedModel
          ? { assignedModel: prev.assignedModel }
          : {}),
    })
  }
  return [...byId.values()]
}

export function gateCompletedStatus(
  item: TodoItem,
  checkPassed: boolean | null,
): { status: TodoStatus; message: string } {
  if (item.status !== 'completed') {
    return { status: item.status, message: '' }
  }
  if (!item.check) {
    return { status: 'completed', message: '' }
  }
  if (checkPassed === true) {
    return { status: 'completed', message: '' }
  }
  const detail =
    checkPassed === false
      ? 'Acceptance check failed — item reverted to in_progress.'
      : 'Acceptance check could not run — item reverted to in_progress.'
  return { status: 'in_progress', message: detail }
}

export function shouldRouteToLocal(
  item: TodoItem,
  opts: { localTodoItemsEnabled: boolean; parentIsLocal: boolean },
): boolean {
  if (!opts.localTodoItemsEnabled || opts.parentIsLocal) return false
  if (item.assignedModel !== 'local') return false
  if (item.status !== 'in_progress') return false
  return !!item.check
}

export function findNewlyInProgressLocal(
  before: readonly TodoItem[],
  after: readonly TodoItem[],
): TodoItem | null {
  const beforeMap = new Map(before.map((t) => [t.id, t]))
  for (const t of after) {
    const prev = beforeMap.get(t.id)
    if (
      t.status === 'in_progress' &&
      prev?.status !== 'in_progress' &&
      t.assignedModel === 'local'
    ) {
      return t
    }
  }
  return null
}

export function findNewlyCompleted(
  before: readonly TodoItem[],
  after: readonly TodoItem[],
): TodoItem | null {
  const beforeMap = new Map(before.map((t) => [t.id, t]))
  for (const t of after) {
    const prev = beforeMap.get(t.id)
    if (t.status === 'completed' && prev?.status !== 'completed') {
      return t
    }
  }
  return null
}

/** Max parent continuation turns before post-turn review when todos are still open. */
export const MAX_PRE_REVIEW_TODO_ATTEMPTS = 2

/** Max review → parent remediation cycles after an editing turn. */
export const MAX_POST_TURN_REVIEW_CYCLES = 2

export const OPEN_TODOS_PRE_REVIEW_NUDGE = `Before this turn can finish, reconcile the task plan:
- Call update_todos (merge=true) to mark completed items done and cancel any you will not do, OR
- Continue working on pending/in_progress items until they are truly finished, then update_todos.
Inspect the diff and transcript — do not leave the plan out of sync with what you actually did.`

export const OPEN_TODOS_REVIEW_REMEDIATION_NUDGE = `Post-turn review flagged follow-up work. Address the review findings below, reconcile todos with update_todos (merge=true), and fix any code issues mentioned.`

export const TODO_STEERING_PROMPT = `When the user asks for multi-step work (refactors, implement-and-test, changes across several files):
1. Call update_todos once with 3+ concrete steps before executing tools.
2. Mark one item in_progress at a time; set completed when done (checks run automatically).
3. Tag mechanical items with assignedModel: "local" only when they include a verifiable check (shell, fileExists, or typecheck).
4. For simple one-shot questions or single-file edits, do NOT create todos.`
