// Sidebar PR data still supports cleanup filtering and visible-thread backfill.
import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountProjectsPane } from './projects-pane.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

function thread(id: string, title: string): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

function apiWithPrDetails(): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    threads: { ...base.threads, listOrphans: async (): Promise<never[]> => [] },
    gh: { ...base.gh, prDetails: async () => null },
  }
}

function rowByTitle(title: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('.chat-row')).find(
    (row) => row.querySelector('.chat-title')?.textContent === title,
  )
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('projects pane PR behavior (component)', () => {
  it('keeps the PR status glyph out of a thread row', async () => {
    const store = createStore({
      projects: [{ id: 'p1', path: '/proj', name: 'Proj' }],
      activeProjectId: 'p1',
      expandedProjectId: 'p1',
      workspaceRoot: '/proj',
      threads: [
        {
          ...thread('linked', 'Linked PR'),
          prRefs: [
            {
              owner: 'copse-dev',
              repo: 'copse-panel',
              number: 42,
              url: 'https://github.com/copse-dev/copse-panel/pull/42',
            },
          ],
        },
      ],
      activeThreadId: 'linked',
    })
    const host = document.createElement('div')
    document.body.append(host)
    const cleanup = mountProjectsPane(host, store, apiWithPrDetails())
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const row = rowByTitle('Linked PR')
      assert.ok(row)
      assert.equal(row.querySelector('.chat-pr-status'), null)
    } finally {
      cleanup()
    }
  })

  it('re-observes the current visible row when an older render request fails', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    t.mock.method(console, 'warn', () => {})
    const originalObserver = globalThis.IntersectionObserver
    const observed = new Set<Element>()
    let deliver: IntersectionObserverCallback | undefined
    let observer: IntersectionObserver | undefined
    class FakeIntersectionObserver implements IntersectionObserver {
      readonly root = null
      readonly rootMargin = '0px'
      readonly scrollMargin = '0px'
      readonly thresholds = [0]

      constructor(callback: IntersectionObserverCallback) {
        deliver = callback
        observer = this
      }

      observe(target: Element): void {
        observed.add(target)
      }

      unobserve(target: Element): void {
        observed.delete(target)
      }

      disconnect(): void {
        observed.clear()
      }

      takeRecords(): IntersectionObserverEntry[] {
        return []
      }
    }
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      writable: true,
      value: FakeIntersectionObserver,
    })

    let attempts = 0
    let rejectFirst: ((reason: Error) => void) | undefined
    const base = apiWithPrDetails()
    const api = {
      ...base,
      threads: {
        ...base.threads,
        backfillPrRefs: async (): Promise<void> => {
          attempts += 1
          if (attempts === 1) {
            return new Promise((_resolve, reject) => {
              rejectFirst = reject
            })
          }
        },
      },
    } satisfies ApiClient
    const store = createStore({
      projects: [{ id: 'p1', path: '/proj', name: 'Proj' }],
      activeProjectId: 'p1',
      expandedProjectId: 'p1',
      workspaceRoot: '/proj',
      threads: [thread('legacy', 'Legacy thread')],
      activeThreadId: 'legacy',
    })
    const host = document.createElement('div')
    document.body.append(host)
    const cleanup = mountProjectsPane(host, store, api)
    try {
      const row = rowByTitle('Legacy thread')
      assert.ok(row)
      assert.ok(deliver)
      assert.ok(observer)
      assert.equal(observed.has(row), true)
      const rect = row.getBoundingClientRect()
      const entry = {
        target: row,
        isIntersecting: true,
        intersectionRatio: 1,
        boundingClientRect: rect,
        intersectionRect: rect,
        rootBounds: null,
        time: 0,
      } satisfies IntersectionObserverEntry

      deliver([entry], observer)
      await Promise.resolve()
      await Promise.resolve()
      assert.equal(attempts, 1)
      assert.equal(observed.has(row), false)

      // A normal sidebar update replaces both the row and observer while the
      // first IPC request remains in flight. The replacement observer sees the
      // row but skips its leased id, then unobserves it.
      store.emit('threads_changed')
      const currentRow = rowByTitle('Legacy thread')
      assert.ok(currentRow)
      assert.notEqual(currentRow, row)
      assert.ok(deliver)
      assert.ok(observer)
      assert.equal(observed.has(currentRow), true)
      const currentRect = currentRow.getBoundingClientRect()
      const currentEntry = {
        target: currentRow,
        isIntersecting: true,
        intersectionRatio: 1,
        boundingClientRect: currentRect,
        intersectionRect: currentRect,
        rootBounds: null,
        time: 0,
      } satisfies IntersectionObserverEntry
      deliver([currentEntry], observer)
      assert.equal(observed.has(currentRow), false)
      assert.equal(attempts, 1)

      assert.ok(rejectFirst)
      rejectFirst(new Error('transient backfill failure'))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // A render during the backoff must not make the still-visible row
      // immediately eligible again. The replacement observer may report it,
      // but the failed request keeps its lease until the retry timer expires.
      store.emit('threads_changed')
      const retryRow = rowByTitle('Legacy thread')
      assert.ok(retryRow)
      assert.notEqual(retryRow, currentRow)
      assert.ok(deliver)
      assert.ok(observer)
      const retryRect = retryRow.getBoundingClientRect()
      const retryEntry = {
        target: retryRow,
        isIntersecting: true,
        intersectionRatio: 1,
        boundingClientRect: retryRect,
        intersectionRect: retryRect,
        rootBounds: null,
        time: 0,
      } satisfies IntersectionObserverEntry
      deliver([retryEntry], observer)
      await Promise.resolve()
      assert.equal(attempts, 1)

      t.mock.timers.tick(999)
      assert.equal(observed.has(retryRow), false)
      t.mock.timers.tick(1)
      assert.equal(observed.has(retryRow), true)

      deliver([retryEntry], observer)
      await Promise.resolve()
      await Promise.resolve()
      assert.equal(attempts, 2)
    } finally {
      cleanup()
      Object.defineProperty(globalThis, 'IntersectionObserver', {
        configurable: true,
        writable: true,
        value: originalObserver,
      })
    }
  })
})
