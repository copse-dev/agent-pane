import { el } from '../dom/helpers.ts'
import type { TodoItem, TodoStatus } from '@shared/types/todo.ts'
import { todoProgress } from '@shared/todos/todo-logic.ts'

function statusIcon(status: TodoStatus): string {
  switch (status) {
    case 'completed':
      return '✓'
    case 'cancelled':
      return '—'
    case 'in_progress':
      return '→'
    default:
      return '○'
  }
}

export function createTodoListEl(todos: TodoItem[], opts?: { compact?: boolean }): HTMLElement {
  const { done, total } = todoProgress(todos)
  const panel = el('div', { class: opts?.compact ? 'todo-panel todo-panel-compact' : 'todo-panel' })
  const header = el('div', { class: 'todo-panel-header' })
  header.append(
    el('span', { class: 'todo-panel-title' }, 'To-dos'),
    el('span', { class: 'todo-panel-count' }, String(total)),
    el('span', { class: 'todo-panel-progress' }, `${done}/${total} done`),
  )
  panel.append(header)

  const list = el('ul', { class: 'todo-list', role: 'list' })
  for (const item of todos) {
    const row = el('li', {
      class: `todo-item todo-item-${item.status}`,
      'data-todo-id': item.id,
      'data-status': item.status,
    })
    row.append(
      el('span', { class: 'todo-status-icon', 'aria-hidden': 'true' }, statusIcon(item.status)),
      el('span', { class: 'todo-content' }, item.content),
    )
    if (item.assignedModel === 'local') {
      row.append(el('span', { class: 'todo-badge todo-badge-local' }, 'local'))
    }
    if (item.check) {
      row.append(el('span', { class: 'todo-badge todo-badge-check' }, item.check.kind))
    }
    list.append(row)
  }
  panel.append(list)
  return panel
}
