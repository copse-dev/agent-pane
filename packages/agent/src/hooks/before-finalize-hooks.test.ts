import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHookRegistry, mergeBlockingOutcomes, FIRST_PARTY_HOOKS } from './hook-registry.ts'
import { BEFORE_FINALIZE_HOOKS, todoFinalizeCloseoutHook } from './before-finalize-hooks.ts'
import {
  MAX_TODO_CLOSEOUT_ATTEMPTS,
  OPEN_TODOS_FINALIZE_NUDGE,
  OPEN_TODOS_FINALIZE_NUDGE_STRICT,
} from '../agent-loop-guards.ts'
import type { TodoItem } from '../wire-types.ts'

const openTodos: TodoItem[] = [
  { id: 't1', content: 'Step one', status: 'pending' },
  { id: 't2', content: 'Step two', status: 'in_progress' },
]

const closedTodos: TodoItem[] = [{ id: 't1', content: 'Step one', status: 'completed' }]

describe('BEFORE_FINALIZE_HOOKS registration', () => {
  it('lists the named closeout hook and is part of FIRST_PARTY_HOOKS', () => {
    assert.deepEqual(
      BEFORE_FINALIZE_HOOKS.map((h) => h.id),
      ['todo-finalize-closeout'],
    )
    assert.deepEqual(
      FIRST_PARTY_HOOKS.filter((h) => h.event === 'beforeFinalize').map((h) => h.id),
      BEFORE_FINALIZE_HOOKS.map((h) => h.id),
    )
  })
})

describe('todo-finalize-closeout', () => {
  it('injects the soft nudge on attempt 0 when todos are open', async () => {
    assert.deepEqual(await todoFinalizeCloseoutHook.run({ openTodos, attempt: 0 }, {}), {
      injectContext: OPEN_TODOS_FINALIZE_NUDGE,
    })
  })

  it('escalates to the strict nudge on later in-budget attempts', async () => {
    for (let attempt = 1; attempt < MAX_TODO_CLOSEOUT_ATTEMPTS; attempt++) {
      assert.deepEqual(await todoFinalizeCloseoutHook.run({ openTodos, attempt }, {}), {
        injectContext: OPEN_TODOS_FINALIZE_NUDGE_STRICT,
      })
    }
  })

  it('abstains when todos are closed', async () => {
    assert.equal(
      await todoFinalizeCloseoutHook.run({ openTodos: closedTodos, attempt: 0 }, {}),
      undefined,
    )
    assert.equal(await todoFinalizeCloseoutHook.run({ openTodos: [], attempt: 0 }, {}), undefined)
  })

  it('abstains once MAX_TODO_CLOSEOUT_ATTEMPTS is exhausted', async () => {
    assert.equal(
      await todoFinalizeCloseoutHook.run({ openTodos, attempt: MAX_TODO_CLOSEOUT_ATTEMPTS }, {}),
      undefined,
    )
    assert.equal(
      await todoFinalizeCloseoutHook.run(
        { openTodos, attempt: MAX_TODO_CLOSEOUT_ATTEMPTS + 1 },
        {},
      ),
      undefined,
    )
  })
})

describe('beforeFinalize emit — byte-identical nudge selection vs previous inline order', () => {
  it('matches the previous attempt→nudge mapping for every in-budget attempt', async () => {
    const registry = createHookRegistry()
    const expected = [
      OPEN_TODOS_FINALIZE_NUDGE,
      OPEN_TODOS_FINALIZE_NUDGE_STRICT,
      OPEN_TODOS_FINALIZE_NUDGE_STRICT,
    ]
    assert.equal(expected.length, MAX_TODO_CLOSEOUT_ATTEMPTS)

    for (let attempt = 0; attempt < MAX_TODO_CLOSEOUT_ATTEMPTS; attempt++) {
      const result = await registry.emit('beforeFinalize', { openTodos, attempt }, {})
      assert.deepEqual(
        result.outcomes.map((o) => o.hookId),
        ['todo-finalize-closeout'],
      )
      assert.equal(mergeBlockingOutcomes(result.outcomes).injectContext, expected[attempt])
    }
  })

  it('emits nothing when todos are closed or the attempt budget is spent', async () => {
    const registry = createHookRegistry()
    assert.deepEqual(
      (await registry.emit('beforeFinalize', { openTodos: closedTodos, attempt: 0 }, {})).outcomes,
      [],
    )
    assert.deepEqual(
      (
        await registry.emit(
          'beforeFinalize',
          { openTodos, attempt: MAX_TODO_CLOSEOUT_ATTEMPTS },
          {},
        )
      ).outcomes,
      [],
    )
  })
})
