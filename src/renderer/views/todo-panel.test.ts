import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTodoListEl } from './todo-panel.ts'
import type { TodoItem } from '@shared/types/todo.ts'

describe('createTodoListEl', () => {
  it('omits cancelled items and reports progress over the remainder', () => {
    const todos: TodoItem[] = [
      { id: '1', content: 'Done step', status: 'completed' },
      { id: '2', content: 'Skipped', status: 'cancelled' },
      { id: '3', content: 'Still open', status: 'pending' },
    ]
    const panel = createTodoListEl(todos)
    assert.ok(panel)
    assert.equal(panel.querySelector('.todo-panel-count')?.textContent, '2')
    assert.equal(panel.querySelector('.todo-panel-progress')?.textContent, '1/2 done')
    assert.equal(panel.querySelectorAll('.todo-item').length, 2)
    assert.equal(panel.querySelector('[data-todo-id="2"]'), null)
    assert.ok(panel.querySelector('[data-todo-id="1"]'))
    assert.ok(panel.querySelector('[data-todo-id="3"]'))
  })

  it('returns null when every todo is cancelled (hide the panel)', () => {
    const todos: TodoItem[] = [
      { id: '1', content: 'Skip A', status: 'cancelled' },
      { id: '2', content: 'Skip B', status: 'cancelled' },
    ]
    assert.equal(createTodoListEl(todos), null)
  })

  it('returns null for an empty list', () => {
    assert.equal(createTodoListEl([]), null)
  })
})
