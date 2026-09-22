import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountTitlebar } from './titlebar.ts'

function thread(id: string, branch: string): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    gitBranch: branch,
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('titlebar branch status', () => {
  it('coalesces same-thread events but refreshes a visible thread switch immediately', async () => {
    const originalResizeObserver = globalThis.ResizeObserver
    class TestResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = TestResizeObserver

    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      threads: [thread('thread-1', 'main'), thread('thread-2', 'feature/two')],
    })
    const root = document.createElement('div')
    document.body.append(root)
    let branchReads = 0
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      git: {
        ...base['git'],
        branchStatus: async (): ReturnType<ApiClient['git']['branchStatus']> => {
          branchReads += 1
          return {
            currentBranch: store.getState().activeThreadId === 'thread-1' ? 'main' : 'feature/two',
            pr: null,
          }
        },
      },
    }

    let destroy: (() => void) | undefined
    try {
      destroy = mountTitlebar(root, store, api)
      await settle()
      assert.equal(branchReads, 1)
      assert.equal(root.querySelector('.workspace-branch')?.textContent, 'main')

      store.emit('threads_changed')
      store.emit('git_branch_changed')
      await settle()
      assert.equal(branchReads, 1, 'same-thread events do not start competing Git reads')

      await new Promise<void>((resolve) => setTimeout(resolve, 550))
      await settle()
      assert.equal(branchReads, 2, 'the event burst resolves to one deferred refresh')

      store.setState({ activeThreadId: 'thread-2' })
      store.emit('threads_changed')
      await settle()
      assert.equal(branchReads, 3, 'a visible thread switch does not wait for the debounce')
      assert.equal(root.querySelector('.workspace-branch')?.textContent, 'feature/two')
    } finally {
      destroy?.()
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})
