import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SidebarThread } from './sidebar-thread.ts'
import {
  groupRowsByStatus,
  orderSidebarRows,
  orderSidebarThreads,
  type SidebarRow,
} from './thread-order.ts'

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

  it('sorts an untitled thread as "New Thread", the name its row shows', () => {
    const threads = [thread('z', 'Zed', 1), thread('blank', '', 2), thread('a', 'alpha', 3)]
    assert.deepEqual(ids(orderSidebarThreads(threads, 'title', false)), ['a', 'blank', 'z'])
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

function row(projectId: string, t: SidebarThread): SidebarRow {
  return { projectId, thread: t }
}
const rowIds = (rows: readonly SidebarRow[]): string[] => rows.map((r) => r.thread.id)

describe('orderSidebarRows', () => {
  const rows = [
    row('p1', { ...thread('old', 'old', 10), lastPromptAt: 90 }),
    row('p2', { ...thread('new', 'new', 5), lastPromptAt: 100 }),
    row('p2', thread('unprompted', 'unprompted', 50)),
  ]

  it('orders activity across projects by last prompt, falling back to creation', () => {
    assert.deepEqual(rowIds(orderSidebarRows(rows, 'activity', false)), [
      'new',
      'old',
      'unprompted',
    ])
  })

  it('sorts by creation and by name, and reverses', () => {
    assert.deepEqual(rowIds(orderSidebarRows(rows, 'created', false)), ['unprompted', 'old', 'new'])
    assert.deepEqual(rowIds(orderSidebarRows(rows, 'title', true)), ['unprompted', 'old', 'new'])
  })
})

describe('groupRowsByStatus', () => {
  const running = row('p1', { ...thread('run', 'run'), status: 'running' })
  const idle = row('p1', thread('idle', 'idle'))
  const asking = row('p2', { ...thread('ask', 'ask'), status: 'running' })

  it('puts a thread that needs the user ahead of working, even while it runs', () => {
    const sections = groupRowsByStatus([running, idle, asking], (id) => id === 'ask')
    assert.deepEqual(
      sections.map((s) => [s.id, rowIds(s.rows)]),
      [
        ['needs-you', ['ask']],
        ['working', ['run']],
        ['recent', ['idle']],
      ],
    )
  })

  it('leaves out an empty section and keeps the incoming order', () => {
    const sections = groupRowsByStatus([idle, row('p1', thread('idle2', 'idle2'))], () => false)
    assert.deepEqual(
      sections.map((s) => s.label),
      ['Recent'],
    )
    assert.deepEqual(rowIds(sections[0]?.rows ?? []), ['idle', 'idle2'])
  })
})
