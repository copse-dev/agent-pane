import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyTodoUpdate,
  gateCompletedStatus,
  hasOpenTodos,
  shouldRouteToLocal,
  shouldSteerTodos,
  todoProgress,
  findNewlyInProgressLocal,
  findNewlyCompleted,
} from './todo-logic.ts'
import type { TodoItem } from '@shared/types/todo.ts'

describe('todo-logic', () => {
  it('applyTodoUpdate replaces the full list by default', () => {
    const current: TodoItem[] = [{ id: 'a', content: 'Old', status: 'pending' }]
    const next = applyTodoUpdate(
      current,
      [
        { content: 'One', status: 'pending' },
        { content: 'Two', status: 'pending' },
      ],
      false,
    )
    assert.equal(next.length, 2)
    assert.ok(next.every((t) => t.id))
  })

  it('applyTodoUpdate merges by id when merge=true', () => {
    const current: TodoItem[] = [{ id: 'a', content: 'Step 1', status: 'pending' }]
    const next = applyTodoUpdate(
      current,
      [{ id: 'a', content: 'Step 1', status: 'completed' }],
      true,
    )
    assert.equal(next.length, 1)
    assert.equal(next[0]?.status, 'completed')
  })

  it('gateCompletedStatus reverts failed checks to in_progress', () => {
    const item: TodoItem = {
      id: '1',
      content: 'Run tests',
      status: 'completed',
      check: { kind: 'shell', command: 'npm test' },
    }
    const gated = gateCompletedStatus(item, false)
    assert.equal(gated.status, 'in_progress')
    assert.match(gated.message, /failed/)
  })

  it('gateCompletedStatus allows completed without check', () => {
    const item: TodoItem = { id: '1', content: 'Think', status: 'completed' }
    assert.equal(gateCompletedStatus(item, null).status, 'completed')
  })

  it('hasOpenTodos detects pending and in_progress', () => {
    assert.equal(hasOpenTodos([{ id: '1', content: 'x', status: 'completed' }]), false)
    assert.equal(hasOpenTodos([{ id: '1', content: 'x', status: 'pending' }]), true)
    assert.equal(hasOpenTodos([{ id: '1', content: 'x', status: 'in_progress' }]), true)
  })

  it('todoProgress ignores cancelled items in total', () => {
    const p = todoProgress([
      { id: '1', content: 'a', status: 'completed' },
      { id: '2', content: 'b', status: 'pending' },
      { id: '3', content: 'c', status: 'cancelled' },
    ])
    assert.deepEqual(p, { done: 1, total: 2 })
  })

  it('shouldSteerTodos for multi-step prompts only', () => {
    assert.equal(shouldSteerTodos('hi'), false)
    assert.equal(
      shouldSteerTodos('Refactor the renderer across several files and then run tests'),
      true,
    )
    assert.equal(shouldSteerTodos('Can you deep dive into reviewing the todo creation part?'), true)
    assert.equal(shouldSteerTodos('Please review the authentication module'), true)
  })

  it('shouldRouteToLocal requires local tag, in_progress, check, and setting', () => {
    const item: TodoItem = {
      id: '1',
      content: 'Add tests',
      status: 'in_progress',
      assignedModel: 'local',
      check: { kind: 'typecheck' },
    }
    assert.equal(
      shouldRouteToLocal(item, { lmStudioForTodoItems: true, parentIsLocal: false }),
      true,
    )
    assert.equal(
      shouldRouteToLocal(item, { lmStudioForTodoItems: false, parentIsLocal: false }),
      false,
    )
    assert.equal(
      shouldRouteToLocal(
        { id: '2', content: 'No check', status: 'in_progress', assignedModel: 'local' },
        { lmStudioForTodoItems: true, parentIsLocal: false },
      ),
      false,
    )
  })

  it('findNewlyInProgressLocal detects transition', () => {
    const before: TodoItem[] = [
      { id: '1', content: 'x', status: 'pending', assignedModel: 'local' },
    ]
    const after: TodoItem[] = [
      { id: '1', content: 'x', status: 'in_progress', assignedModel: 'local' },
    ]
    assert.equal(findNewlyInProgressLocal(before, after)?.id, '1')
  })

  it('findNewlyCompleted detects transition', () => {
    const before: TodoItem[] = [{ id: '1', content: 'x', status: 'in_progress' }]
    const after: TodoItem[] = [{ id: '1', content: 'x', status: 'completed' }]
    assert.equal(findNewlyCompleted(before, after)?.id, '1')
  })
})
