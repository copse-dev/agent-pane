import type { LLMMessage } from '@shared/types'
import type { TodoItem } from '@shared/types/todo.ts'
import { formatTodosForPrompt } from './todo-logic.ts'

const TODO_PIN_PREFIX = '\n\n---\n\n## Active plan (pinned)\n'

/**
 * After a todo item completes, compact history while keeping the pinned plan.
 * Drops oldest assistant/tool pairs; never removes user messages.
 */
export function compactAtTodoBoundary(
  messages: LLMMessage[],
  todos: readonly TodoItem[],
  opts?: { keepRecentPairs?: number },
): boolean {
  const keepRecent = opts?.keepRecentPairs ?? 2
  if (messages.length <= keepRecent + 2) return false

  const start = messages[0]?.role === 'system' ? 1 : 0
  const system = messages[0]?.role === 'system' ? messages[0] : null
  const pinned = formatTodosForPrompt(todos)
  if (system && pinned) {
    const base = typeof system.content === 'string' ? system.content : ''
    const marker = TODO_PIN_PREFIX
    const idx = base.indexOf(marker)
    const withoutOldPlan = idx >= 0 ? base.slice(0, idx) : base
    messages[0] = { role: 'system', content: withoutOldPlan + marker + pinned.trim() }
  }

  let removed = false
  while (messages.length - start > keepRecent + 1) {
    let dropIndex = -1
    for (let i = start; i < messages.length; i++) {
      const m = messages[i]
      if (!m || m.role === 'user') continue
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        const next = messages[i + 1]
        if (next?.role === 'tool') {
          dropIndex = i
          break
        }
      }
      if (m.role === 'assistant' && typeof m.content === 'string') {
        dropIndex = i
        break
      }
    }
    if (dropIndex < 0) break
    const dropMsg = messages[dropIndex]
    const span =
      dropMsg?.role === 'assistant' &&
      Array.isArray(dropMsg.content) &&
      messages[dropIndex + 1]?.role === 'tool'
        ? 2
        : 1
    messages.splice(dropIndex, span)
    removed = true
  }
  return removed
}
