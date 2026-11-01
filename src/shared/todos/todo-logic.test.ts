import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  activeTodos,
  applyTodoUpdate,
  gateCompletedStatus,
  holdChecksAttachedAtCompletion,
  refuseUncheckedRevivalOfCancelled,
  shouldRouteToLocal,
  shouldSteerTodos,
  todoProgress,
  findNewlyInProgressLocal,
  findNewlyCompleted,
} from './todo-logic.ts'
import type { TodoItem } from '@shared/types/todo.ts'

describe('todo-logic', () => {
  describe('holdChecksAttachedAtCompletion', () => {
    const fetchCheck = { kind: 'shell', command: 'git fetch origin main', expectExit: 0 } as const
    const prCheck = { kind: 'shell', command: 'gh pr view --json url', expectExit: 0 } as const

    it('keeps an item in_progress when its check first appears in the completing call', () => {
      // The #1433 shape: t3 went cancelled -> completed and acquired a check in
      // the same update_todos call, after the fetch it describes never ran.
      const before: TodoItem[] = [{ id: 't3', content: 'Fetch and rebase', status: 'cancelled' }]
      const after: TodoItem[] = [
        { id: 't3', content: 'Fetch and rebase', status: 'completed', check: prCheck },
      ]
      const held = holdChecksAttachedAtCompletion(before, after)
      assert.deepEqual(held.todos, [
        { id: 't3', content: 'Fetch and rebase', status: 'in_progress', check: prCheck },
      ])
      assert.deepEqual(held.messages, [
        'Fetch and rebase: acceptance check was attached in the same call that marked it completed, so it cannot verify the work. Kept in_progress with the check recorded; complete it in a later update_todos call.',
      ])
    })

    it('holds a completion whose check was swapped for a different one', () => {
      const before: TodoItem[] = [
        { id: 't3', content: 'Fetch and rebase', status: 'in_progress', check: fetchCheck },
      ]
      const after: TodoItem[] = [
        { id: 't3', content: 'Fetch and rebase', status: 'completed', check: prCheck },
      ]
      const held = holdChecksAttachedAtCompletion(before, after)
      assert.deepEqual(held.todos, [
        { id: 't3', content: 'Fetch and rebase', status: 'in_progress', check: prCheck },
      ])
      assert.equal(held.messages.length, 1)
    })

    it('lets a completion through when the check was committed to earlier', () => {
      const before: TodoItem[] = [
        { id: 't3', content: 'Fetch and rebase', status: 'in_progress', check: fetchCheck },
      ]
      const after: TodoItem[] = [
        { id: 't3', content: 'Fetch and rebase', status: 'completed', check: { ...fetchCheck } },
      ]
      const held = holdChecksAttachedAtCompletion(before, after)
      assert.deepEqual(held.todos, after)
      assert.deepEqual(held.messages, [])
    })

    it('ignores items without a check, already-completed items, and new items', () => {
      const before: TodoItem[] = [
        { id: 'a', content: 'No check', status: 'in_progress' },
        { id: 'b', content: 'Already done', status: 'completed' },
      ]
      const after: TodoItem[] = [
        { id: 'a', content: 'No check', status: 'completed' },
        { id: 'b', content: 'Already done', status: 'completed', check: prCheck },
        { id: 'c', content: 'Brand new', status: 'completed', check: prCheck },
      ]
      const held = holdChecksAttachedAtCompletion(before, after)
      assert.deepEqual(held.todos, after)
      assert.deepEqual(held.messages, [])
    })
  })

  describe('refuseUncheckedRevivalOfCancelled', () => {
    const prCheck = { kind: 'shell', command: 'gh pr view --json url', expectExit: 0 } as const

    it('keeps a cancelled item cancelled when it is marked completed without a check', () => {
      const before: TodoItem[] = [{ id: 't3', content: 'Fetch and rebase', status: 'cancelled' }]
      const after: TodoItem[] = [{ id: 't3', content: 'Fetch and rebase', status: 'completed' }]
      const refused = refuseUncheckedRevivalOfCancelled(before, after)
      assert.deepEqual(refused.todos, before)
      assert.equal(refused.messages.length, 1)
      assert.match(
        refused.messages[0] ?? '',
        /cannot be marked completed without an acceptance check/,
      )
    })

    it('lets a cancelled item with its earlier check through to the gate, which runs it', () => {
      const before: TodoItem[] = [
        { id: 't3', content: 'Fetch and rebase', status: 'cancelled', check: prCheck },
      ]
      const after: TodoItem[] = [
        { id: 't3', content: 'Fetch and rebase', status: 'completed', check: prCheck },
      ]
      assert.deepEqual(refuseUncheckedRevivalOfCancelled(before, after), {
        todos: after,
        messages: [],
      })
    })

    it('allows reopening a cancelled item and leaves other transitions alone', () => {
      const before: TodoItem[] = [
        { id: 'a', content: 'Reopen', status: 'cancelled' },
        { id: 'b', content: 'Normal', status: 'in_progress' },
      ]
      const after: TodoItem[] = [
        { id: 'a', content: 'Reopen', status: 'in_progress' },
        { id: 'b', content: 'Normal', status: 'completed' },
        { id: 'c', content: 'New', status: 'completed' },
      ]
      assert.deepEqual(refuseUncheckedRevivalOfCancelled(before, after), {
        todos: after,
        messages: [],
      })
    })
  })

  describe('#1433 t3 replay (reconstructed from the issue; the run did not keep its calls)', () => {
    // The update_todos pipeline as todo-tool.ts runs it, with the shell check's
    // outcome injected: the `gh pr view` check would have passed, because a PR
    // existed — it just verified nothing about the fetch.
    function update(
      before: TodoItem[],
      incoming: Parameters<typeof applyTodoUpdate>[1],
      checkPasses: boolean,
    ): TodoItem[] {
      const held = holdChecksAttachedAtCompletion(before, applyTodoUpdate(before, incoming, true))
      const revived = refuseUncheckedRevivalOfCancelled(before, held.todos)
      return revived.todos.map((item) =>
        item.status === 'completed' && item.check
          ? { ...item, status: gateCompletedStatus(item, checkPasses).status }
          : item,
      )
    }
    const content = 'Fetch origin/main and rebase branch onto latest'
    const prCheck = {
      kind: 'shell',
      command: "gh pr view --json number,url | jq -r '.url'",
      expectExit: 0,
    } as const

    it('never records t3 completed by a check it attached in the completing call', () => {
      let plan: TodoItem[] = [{ id: 't3', content, status: 'pending' }]
      plan = update(plan, [{ id: 't3', content, status: 'in_progress' }], true)
      // Both fetches 403'd; the run gave up on the item.
      plan = update(plan, [{ id: 't3', content, status: 'cancelled' }], true)
      // The recorded call: cancelled -> completed, acquiring a check at once.
      plan = update(plan, [{ id: 't3', content, status: 'completed', check: prCheck }], true)
      assert.equal(plan[0]?.status, 'in_progress')
    })

    it('never records t3 completed straight from cancelled without a check', () => {
      let plan: TodoItem[] = [{ id: 't3', content, status: 'cancelled' }]
      plan = update(plan, [{ id: 't3', content, status: 'completed' }], true)
      assert.equal(plan[0]?.status, 'cancelled')
    })
  })

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

  it('applyTodoUpdate carries completed work through a full replace', () => {
    // The replan that motivated this: an eight-item plan swapped wholesale for
    // fresh ids, taking every finished step with it.
    const current: TodoItem[] = [
      { id: 't1', content: 'Consolidate reviewer feedback', status: 'completed' },
      { id: 't2', content: 'Scaffold the crate', status: 'completed' },
      { id: 't3', content: 'Port the runtime', status: 'in_progress' },
    ]
    const next = applyTodoUpdate(
      current,
      [
        { id: 's1', content: 'Restore crate-root webview types', status: 'in_progress' },
        { id: 's2', content: 'Add compat shims', status: 'pending' },
      ],
      false,
    )

    assert.deepEqual(
      next.map((t) => t.id),
      ['t1', 't2', 's1', 's2'],
      'finished work survives, in front of the new plan',
    )
    assert.ok(!next.some((t) => t.id === 't3'), 'unfinished work the replan dropped is gone')
  })

  it('applyTodoUpdate lets a replan reopen completed work when it says so explicitly', () => {
    const current: TodoItem[] = [{ id: 'a', content: 'Port the runtime', status: 'completed' }]
    const next = applyTodoUpdate(
      current,
      [{ id: 'a', content: 'Port the runtime', status: 'in_progress' }],
      false,
    )

    assert.equal(next.length, 1)
    assert.equal(next[0]?.status, 'in_progress')
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

  it('todoProgress ignores cancelled items in total', () => {
    const p = todoProgress([
      { id: '1', content: 'a', status: 'completed' },
      { id: '2', content: 'b', status: 'pending' },
      { id: '3', content: 'c', status: 'cancelled' },
    ])
    assert.deepEqual(p, { done: 1, total: 2 })
  })

  it('activeTodos drops cancelled items', () => {
    const visible = activeTodos([
      { id: '1', content: 'a', status: 'completed' },
      { id: '2', content: 'b', status: 'cancelled' },
      { id: '3', content: 'c', status: 'pending' },
    ])
    assert.deepEqual(
      visible.map((t) => t.id),
      ['1', '3'],
    )
  })

  it('todoProgress is 0/0 when every item is cancelled', () => {
    assert.deepEqual(todoProgress([{ id: '1', content: 'skip', status: 'cancelled' }]), {
      done: 0,
      total: 0,
    })
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
      shouldRouteToLocal(item, { localTodoItemsEnabled: true, parentIsLocal: false }),
      true,
    )
    assert.equal(
      shouldRouteToLocal(item, { localTodoItemsEnabled: false, parentIsLocal: false }),
      false,
    )
    assert.equal(
      shouldRouteToLocal(
        { id: '2', content: 'No check', status: 'in_progress', assignedModel: 'local' },
        { localTodoItemsEnabled: true, parentIsLocal: false },
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
