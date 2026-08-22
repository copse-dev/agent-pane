// Todo turn-start steering — owned by `@copse/agent` so first-party hooks can
// use it without importing the host app (execution-guidance rule 4). `@shared`
// re-exports these for existing app/script consumers.
import type { TodoItem } from './wire-types.ts'

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

/**
 * Format todos as a prompt block. Includes a leading `\n\n` so callers can append
 * it directly to a system message (turn-start pin and compaction both do this).
 */
export function formatTodosForPrompt(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return ''
  const lines = todos.map((t) => {
    const model = t.assignedModel ? ` [${t.assignedModel}]` : ''
    const check = t.check ? ` (check: ${t.check.kind})` : ''
    return `- [${t.status}] ${t.content}${model}${check} (id: ${t.id})`
  })
  return `\n\n## Current plan\n${lines.join('\n')}`
}

export const TODO_STEERING_PROMPT = `When the user asks for multi-step work (refactors, implement-and-test, changes across several files):
1. Call update_todos once with 3+ concrete steps before executing tools.
2. Mark one item in_progress at a time; set completed when done (checks run automatically).
3. Tag mechanical items with assignedModel: "local" only when they include a verifiable check (shell, fileExists, or typecheck).
4. For simple one-shot questions or single-file edits, do NOT create todos.`
