import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread, setThreadTodos } from '@shared/store/thread-helpers.ts'
import { followUpContextSchema } from '../../main/ipc/ipc-guards.ts'
import { lastExchange } from './last-exchange.ts'

function storeWithFinishedTurn(): { store: ReturnType<typeof createStore>; threadId: string } {
  const store = createStore()
  store.setState({ activeProjectId: 'project-1' })
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', 'do the thing')
  addMessage(store, threadId, 'assistant', 'Mostly done.')
  return { store, threadId }
}

describe('lastExchange openTodos', () => {
  it('carries only pending/in_progress plan items at turn end', () => {
    const { store, threadId } = storeWithFinishedTurn()
    setThreadTodos(store, threadId, [
      { id: 't1', content: 'Write tests', status: 'completed' },
      { id: 't2', content: 'Update changelog', status: 'pending' },
      { id: 't3', content: 'Polish docs', status: 'in_progress' },
      { id: 't4', content: 'Old idea', status: 'cancelled' },
    ])

    const exchange = lastExchange(store, threadId)
    assert.ok(exchange)
    assert.deepEqual(exchange.context.openTodos, ['Update changelog', 'Polish docs'])
  })

  it('omits openTodos when the plan is absent or fully reconciled', () => {
    const { store, threadId } = storeWithFinishedTurn()

    const noPlan = lastExchange(store, threadId)
    assert.ok(noPlan)
    assert.equal(noPlan.context.openTodos, undefined)

    setThreadTodos(store, threadId, [{ id: 't1', content: 'Only step', status: 'completed' }])
    const reconciled = lastExchange(store, threadId)
    assert.ok(reconciled)
    // Absent, not empty: the suggestion prompts treat both alike, but keeping
    // the payload out of the IPC round-trip keeps the common case clean.
    assert.equal(reconciled.context.openTodos, undefined)
  })

  it('normalizes a runaway persisted plan into an IPC-valid context', () => {
    const { store, threadId } = storeWithFinishedTurn()
    setThreadTodos(store, threadId, [
      { id: 'long', content: `  ${'x'.repeat(600)}  `, status: 'in_progress' },
      { id: 'blank', content: '   ', status: 'pending' },
      ...Array.from({ length: 25 }, (_, index) => ({
        id: `extra-${String(index)}`,
        content: `Extra item ${String(index)}`,
        status: 'pending' as const,
      })),
    ])

    const exchange = lastExchange(store, threadId)
    assert.ok(exchange)
    const { openTodos } = exchange.context
    assert.ok(openTodos)
    assert.equal(openTodos.length, 20)
    assert.equal(openTodos[0]?.length, 500)
    assert.equal(followUpContextSchema.safeParse(exchange.context).success, true)
  })
})
