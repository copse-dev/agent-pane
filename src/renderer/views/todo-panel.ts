import { el } from '../dom/helpers.ts'
import { arrowRightIcon, checkIcon, circleIcon } from '../dom/icons.ts'
import type { TodoItem, TodoStatus } from '@shared/types/todo.ts'
import { activeTodos, todoProgress } from '@shared/todos/todo-logic.ts'

function statusIcon(status: Exclude<TodoStatus, 'cancelled'>): SVGSVGElement {
  switch (status) {
    case 'completed':
      return checkIcon('ui-icon ui-icon-sm')
    case 'in_progress':
      return arrowRightIcon('ui-icon ui-icon-sm')
    default:
      return circleIcon('ui-icon ui-icon-sm')
  }
}

/**
 * Renders the inline To-dos panel. Cancelled items are omitted (they are no
 * longer part of the plan). When nothing remains to show, returns a hidden
 * sentinel (not `.todo-panel`) so callers can always append without leaving a
 * visible 0/0 shell.
 */
export function createTodoListEl(todos: TodoItem[], opts?: { compact?: boolean }): HTMLElement {
  const visible = activeTodos(todos)
  if (visible.length === 0) {
    return el('div', {
      class: 'todo-panel-absent',
      hidden: true,
      'aria-hidden': 'true',
      'data-todo-panel': 'absent',
    })
  }

  const { done, total } = todoProgress(visible)
  const panel = el('div', { class: opts?.compact ? 'todo-panel todo-panel-compact' : 'todo-panel' })
  const header = el('div', { class: 'todo-panel-header' })
  header.append(
    el('span', { class: 'todo-panel-title' }, 'To-dos'),
    el('span', { class: 'todo-panel-count' }, String(total)),
    el('span', { class: 'todo-panel-progress' }, `${String(done)}/${String(total)} done`),
  )
  panel.append(header)

  const list = el('ul', { class: 'todo-list', role: 'list' })
  for (const item of visible) {
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
