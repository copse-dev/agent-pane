import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { selectActiveWorkspace, type ActiveWorkspace } from './active-workspace.ts'

describe('selectActiveWorkspace', () => {
  it('reports a project switch and a root change, not unrelated writes', () => {
    const store = createStore({ activeProjectId: 'p1', workspaceRoot: '/p1' })
    const seen: [ActiveWorkspace, ActiveWorkspace][] = []
    selectActiveWorkspace(store, (next, prev) => seen.push([next, prev]))

    store.setState({ activeThreadId: 't1', threads: [] })
    store.setState({ activeProjectId: 'p1', workspaceRoot: '/p1' })
    assert.deepEqual(seen, [], 'an unchanged selection is quiet')

    store.setState({ activeProjectId: 'p2', workspaceRoot: '/p2' })
    assert.deepEqual(
      seen,
      [
        [
          ['p2', '/p2'],
          ['p1', '/p1'],
        ],
      ],
      'one switch, one notification',
    )
  })

  it('hears the root arrive after the project id, as quarantine-and-restore writes them', () => {
    const store = createStore({ activeProjectId: 'missing', workspaceRoot: '/missing' })
    const seen: ActiveWorkspace[] = []
    selectActiveWorkspace(store, (next) => seen.push(next))

    store.setState({ activeProjectId: 'next', threads: [], activeThreadId: null })
    store.setState({ workspaceRoot: '/next' })

    assert.deepEqual(seen, [
      ['next', '/missing'],
      ['next', '/next'],
    ])
  })

  it('stops after unsubscribe', () => {
    const store = createStore()
    let calls = 0
    const stop = selectActiveWorkspace(store, () => {
      calls += 1
    })
    stop()
    store.setState({ activeProjectId: 'p1', workspaceRoot: '/p1' })
    assert.equal(calls, 0)
  })
})
