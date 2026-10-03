import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SidebarThread } from './sidebar-thread.ts'
import { orderSidebarThreads } from './thread-order.ts'

function thread(id: string, title: string, createdAt?: number): SidebarThread {
  return { id, title, status: 'idle', ...(createdAt === undefined ? {} : { createdAt }) }
}

const ids = (threads: readonly SidebarThread[]): string[] => threads.map((t) => t.id)

// Store order: most recently prompted first, which is not creation order.
const storeOrder = [thread('b', 'beta', 20), thread('c', 'Charlie', 30), thread('a', 'alpha', 10)]

describe('orderSidebarThreads', () => {
  it('keeps the store order for activity', () => {
    assert.deepEqual(ids(orderSidebarThreads(storeOrder, 'activity', false)), ['b', 'c', 'a'])
  })

  it('sorts by creation time, newest first', () => {
    assert.deepEqual(ids(orderSidebarThreads(storeOrder, 'created', false)), ['c', 'b', 'a'])
  })

  it('sorts by title without regard to case', () => {
    assert.deepEqual(ids(orderSidebarThreads(storeOrder, 'title', false)), ['a', 'b', 'c'])
  })

  it('flips whichever order was chosen', () => {
    assert.deepEqual(ids(orderSidebarThreads(storeOrder, 'activity', true)), ['a', 'c', 'b'])
    assert.deepEqual(ids(orderSidebarThreads(storeOrder, 'title', true)), ['c', 'b', 'a'])
  })

  it('keeps store order for threads a sort cannot tell apart', () => {
    const tied = [thread('x', 'same'), thread('y', 'same'), thread('z', 'same')]
    assert.deepEqual(ids(orderSidebarThreads(tied, 'title', false)), ['x', 'y', 'z'])
    assert.deepEqual(ids(orderSidebarThreads(tied, 'created', false)), ['x', 'y', 'z'])
  })

  it('does not mutate its input', () => {
    const input = [...storeOrder]
    orderSidebarThreads(input, 'title', true)
    assert.deepEqual(ids(input), ['b', 'c', 'a'])
  })
})
