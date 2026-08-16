import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountTitlebar } from './titlebar.ts'

afterEach(() => {
  document.body.replaceChildren()
})

describe('titlebar branch', () => {
  it('resyncs the workspace branch from recursive working-tree events (#1753)', async () => {
    const originalResizeObserver = globalThis.ResizeObserver
    class NoopResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = NoopResizeObserver

    const store = createStore({
      workspaceRoot: '/repo',
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      projects: [{ id: 'project-1', path: '/repo', name: 'repo' }],
      threads: [
        {
          id: 'thread-1',
          title: 'Test',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    const listener: { current: ((root: string) => void) | null } = { current: null }
    let branchReads = 0
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      git: {
        ...base['git'],
        branchStatus: async () => {
          branchReads++
          return { currentBranch: branchReads === 1 ? 'main' : 'feature/external', pr: null }
        },
        onWorkingTreeChanged: (handler: (root: string) => void): (() => void) => {
          listener.current = handler
          return () => {
            if (listener.current === handler) listener.current = null
          }
        },
      },
    }

    const host = document.createElement('div')
    document.body.append(host)
    const destroy = mountTitlebar(host, store, api)
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(host.querySelector('.workspace-branch')?.textContent, 'main')
    assert.ok(listener.current)

    listener.current('/repo')
    await new Promise<void>((resolve) => setTimeout(resolve, 550))
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(host.querySelector('.workspace-branch')?.textContent, 'feature/external')

    destroy()
    globalThis.ResizeObserver = originalResizeObserver
    assert.equal(listener.current, null)
  })
})
