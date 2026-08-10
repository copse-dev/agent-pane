import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { StagedDiffEntry } from '@shared/types/state.ts'
import { attachDiffState } from './diff-state.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

type QueuedHandler = (projectId: string, threadId: string, entries: StagedDiffEntry[]) => void
type ShowDiffHandler = (
  projectId: string,
  threadId: string,
  path: string,
  before: string,
  after: string,
  language: string,
) => void

interface Harness {
  api: ApiClient
  queueCalls: [string, string][]
  emitQueued: QueuedHandler
  emitShowDiff: ShowDiffHandler
}

function harness(queues: Record<string, StagedDiffEntry[]>): Harness {
  let queued: QueuedHandler = () => {}
  let showDiff: ShowDiffHandler = () => {}
  const queueCalls: [string, string][] = []
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    diff: {
      ...base['diff'],
      queue: async (projectId: string, threadId: string): Promise<StagedDiffEntry[]> => {
        queueCalls.push([projectId, threadId])
        return queues[`${projectId}/${threadId}`] ?? []
      },
      onQueued: (handler: QueuedHandler) => {
        queued = handler
        return (): void => {}
      },
      onShowDiff: (handler: ShowDiffHandler) => {
        showDiff = handler
        return (): void => {}
      },
    },
  }
  return {
    api,
    queueCalls,
    emitQueued: (...args): void => {
      queued(...args)
    },
    emitShowDiff: (...args): void => {
      showDiff(...args)
    },
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('diff state', () => {
  it('hydrates the queue on attach instead of waiting for a push', async () => {
    // #1704: `diff:queued` is a push, so a renderer that boots mid-run (a pane
    // pop-out, or the main window after a reload) started with an empty queue
    // and stayed empty until the agent happened to stage something else.
    const store = createStore({ activeProjectId: 'project-1', activeThreadId: 'thread-1' })
    const h = harness({
      'project-1/thread-1': [{ path: 'already-staged.ts', language: 'typescript' }],
    })

    attachDiffState(store, h.api, { revealOnShowDiff: false })
    await settle()

    assert.deepEqual(store.getState().stagedDiffs, [
      { path: 'already-staged.ts', language: 'typescript' },
    ])
    assert.deepEqual(h.queueCalls, [['project-1', 'thread-1']])
  })

  it('re-hydrates for the new thread on a thread switch', async () => {
    const store = createStore({ activeProjectId: 'project-1', activeThreadId: 'thread-a' })
    const h = harness({
      'project-1/thread-a': [{ path: 'a.ts', language: 'typescript' }],
      'project-1/thread-b': [{ path: 'b.ts', language: 'typescript' }],
    })

    attachDiffState(store, h.api, { revealOnShowDiff: false })
    await settle()
    assert.deepEqual(store.getState().stagedDiffs, [{ path: 'a.ts', language: 'typescript' }])

    store.setState({ activeThreadId: 'thread-b' })
    store.emit('threads_changed')
    await settle()

    assert.deepEqual(store.getState().stagedDiffs, [{ path: 'b.ts', language: 'typescript' }])
  })

  it('ignores a hydrate that resolves after the thread moved on', async () => {
    const store = createStore({ activeProjectId: 'project-1', activeThreadId: 'thread-a' })
    const h = harness({ 'project-1/thread-a': [{ path: 'stale.ts', language: 'typescript' }] })

    // Switch away before the in-flight read for thread-a can resolve.
    attachDiffState(store, h.api, { revealOnShowDiff: false })
    store.setState({ activeThreadId: 'thread-b' })
    store.emit('threads_changed')
    await settle()

    assert.deepEqual(store.getState().stagedDiffs, [], "thread-a's queue must not land on thread-b")
  })

  it('scopes pushes to the active owner', async () => {
    const store = createStore({ activeProjectId: 'project-1', activeThreadId: 'thread-1' })
    const h = harness({})
    attachDiffState(store, h.api, { revealOnShowDiff: false })
    await settle()

    h.emitQueued('project-1', 'other-thread', [{ path: 'nope.ts', language: 'typescript' }])
    assert.deepEqual(store.getState().stagedDiffs, [])

    h.emitQueued('project-1', 'thread-1', [{ path: 'yes.ts', language: 'typescript' }])
    assert.deepEqual(store.getState().stagedDiffs, [{ path: 'yes.ts', language: 'typescript' }])
  })

  it('records a proposed payload without forcing the panel open when not revealing', async () => {
    // A pop-out is already pinned to one pane; re-running the reveal would fight
    // whatever the window is showing.
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      rightPanelMode: 'terminal',
      filesPaneOpen: false,
    })
    const h = harness({})
    attachDiffState(store, h.api, { revealOnShowDiff: false })
    await settle()

    let reveals = 0
    store.on('right_panel_mode_changed', () => {
      reveals++
    })

    h.emitShowDiff('project-1', 'thread-1', 'x.ts', 'old\n', 'new\n', 'typescript')

    assert.deepEqual(store.getState().activeDiff, {
      path: 'x.ts',
      before: 'old\n',
      after: 'new\n',
      language: 'typescript',
    })
    assert.equal(store.getState().rightPanelMode, 'terminal', 'pane must not be switched')
    assert.equal(store.getState().filesPaneOpen, false)
    assert.equal(reveals, 0)
  })

  it('opens Changes on a proposal when revealing', async () => {
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      rightPanelMode: 'terminal',
      filesPaneOpen: false,
    })
    const h = harness({})
    attachDiffState(store, h.api, { revealOnShowDiff: true })
    await settle()

    h.emitShowDiff('project-1', 'thread-1', 'x.ts', 'old\n', 'new\n', 'typescript')

    assert.equal(store.getState().rightPanelMode, 'changes')
    assert.equal(store.getState().filesPaneOpen, true)
  })

  it('survives a hydrate that rejects', async () => {
    const store = createStore({ activeProjectId: 'project-1', activeThreadId: 'thread-1' })
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      diff: {
        ...base['diff'],
        queue: async (): Promise<StagedDiffEntry[]> => {
          throw new Error('main process is not ready')
        },
      },
    }

    attachDiffState(store, api, { revealOnShowDiff: false })
    await settle()

    assert.deepEqual(store.getState().stagedDiffs, [])
  })
})
