import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { GitStatusResult } from '@shared/types/git.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { createThreadBrowserData, type ThreadBrowserEntry } from './thread-browser.ts'

function thread(id: string, retired = false): Thread {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 2,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    ...(retired
      ? {
          worktree: {
            path: '/retired',
            branch: 'retired',
            baseBranch: 'main',
            baseCommit: 'abc',
            createdAt: 1,
            seededFromDirtyProject: false,
            retiredAt: 2,
          },
        }
      : {}),
  }
}

/** A thread on its own worktree, so its status read is not shared. */
function isolated(id: string): Thread {
  return {
    ...thread(id),
    worktree: {
      path: `/worktrees/${id}`,
      branch: id,
      baseBranch: 'main',
      baseCommit: 'abc',
      createdAt: 1,
      seededFromDirtyProject: false,
    },
  }
}

describe('thread browser data', () => {
  it('rechecks when a refresh arrives during an older status read', async () => {
    const api = createFakeApi()
    const store = createStore({
      projects: [{ id: 'project', name: 'Project', path: '/project' }],
      activeProjectId: 'project',
      threads: [thread('first')],
    })
    let reads = 0
    api.git.status = async (): Promise<GitStatusResult> => {
      reads += 1
      const first = reads === 1
      await delay(10)
      return { staged: [], unstaged: first ? [] : [{ path: 'new.txt', status: 'untracked' }] }
    }
    const data = createThreadBrowserData(store, api, () => {})
    const entries = data.entries()
    data.inspect(entries)
    data.inspect(entries, true)
    await delay(60)
    assert.equal(reads, 2)
    const entry = entries[0]
    assert.ok(entry)
    assert.equal(data.summary(entry)?.count, 1)
    data.dispose()
  })
  it('lists metadata without reading conversation messages', () => {
    const metadata = thread('large-conversation')
    Object.defineProperty(metadata, 'messages', {
      get: (): never => {
        throw new Error('Transcript read')
      },
    })
    const store = createStore({
      projects: [{ id: 'project', name: 'Project', path: '/project' }],
      activeProjectId: 'project',
      threads: [metadata],
    })
    const data = createThreadBrowserData(store, createFakeApi(), () => {})
    assert.equal(data.entries()[0]?.thread.title, 'large-conversation')
    data.dispose()
  })
  it('bounds concurrent Git reads and never inspects retired worktrees', async () => {
    const api = createFakeApi()
    const store = createStore({
      projects: [{ id: 'project', name: 'Project', path: '/project' }],
      activeProjectId: 'project',
      threads: [isolated('first'), isolated('second'), isolated('third'), thread('retired', true)],
    })
    let concurrent = 0
    let maxConcurrent = 0
    const reads: string[] = []
    api.git.status = async (_projectId, threadId, inspectOnly): Promise<GitStatusResult> => {
      assert.equal(inspectOnly, true)
      reads.push(threadId)
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await delay(10)
      concurrent -= 1
      return { staged: [], unstaged: [] }
    }
    const data = createThreadBrowserData(store, api, () => {})
    data.inspect(data.entries())
    await delay(60)
    assert.equal(maxConcurrent, 2)
    assert.deepEqual(reads, ['first', 'second', 'third'])
    assert.equal(data.pending(), false)
    const retired = data.entries().find((entry) => entry.thread.id === 'retired')
    assert.ok(retired)
    assert.equal(data.summary(retired), null)
    data.dispose()
  })

  it('reads a shared checkout once and falls back to another thread on failure', async () => {
    const api = createFakeApi()
    const store = createStore({
      projects: [{ id: 'project', name: 'Project', path: '/project' }],
      activeProjectId: 'project',
      threads: [thread('unsaved'), thread('first'), thread('second')],
    })
    const reads: string[] = []
    api.git.status = async (_projectId, threadId): Promise<GitStatusResult> => {
      reads.push(threadId)
      if (threadId === 'unsaved') throw new Error('Thread is not persisted yet')
      return { staged: [], unstaged: [{ path: 'dirty.ts', status: 'modified' }] }
    }
    const data = createThreadBrowserData(store, api, () => {})
    data.inspect(data.entries())
    await delay(30)
    assert.deepEqual(reads, ['unsaved', 'first'])
    for (const entry of data.entries()) assert.equal(data.summary(entry)?.count, 1)
    data.dispose()
  })

  it('re-reads only the checkout a working-tree event names', async () => {
    const api = createFakeApi()
    const store = createStore({
      projects: [
        { id: 'one', name: 'One', path: '/one' },
        { id: 'two', name: 'Two', path: '/two' },
      ],
      activeProjectId: 'one',
      threads: [thread('shared-a'), thread('shared-b'), isolated('isolated')],
    })
    api.threads.loadProject = async (): Promise<Thread[]> => [thread('other'), isolated('other-wt')]
    const reads: string[] = []
    api.git.status = async (_projectId, threadId): Promise<GitStatusResult> => {
      reads.push(threadId)
      return { staged: [], unstaged: [] }
    }
    const data = createThreadBrowserData(store, api, () => {})
    data.load()
    await delay(10)
    data.inspect(data.entries())
    await delay(30)
    // Two shared checkouts and two worktrees: four reads, not one per thread.
    assert.equal(reads.length, 4)
    reads.length = 0
    data.invalidateRoot('/somewhere/else')
    await delay(20)
    assert.deepEqual(reads, [])
    data.invalidateRoot('/one/')
    await delay(20)
    assert.equal(reads.length, 1)
    reads.length = 0
    data.invalidateRoot('/worktrees/isolated')
    await delay(20)
    assert.deepEqual(reads, ['isolated'])
    reads.length = 0
    // An ordinary render inside the freshness window reads nothing.
    data.inspect(data.entries())
    await delay(20)
    assert.deepEqual(reads, [])
    data.dispose()
  })

  it('re-reads other projects after their metadata ages out and applies PR links', async () => {
    const api = createFakeApi()
    let clock = 1_000
    let title = 'before'
    let prRefsListener: Parameters<typeof api.threads.onPrRefs>[0] = () => {}
    api.threads.onPrRefs = (listener): (() => void) => {
      prRefsListener = listener
      return () => {}
    }
    api.threads.loadProject = async (): Promise<Thread[]> => [{ ...thread('other'), title }]
    const store = createStore({
      projects: [
        { id: 'one', name: 'One', path: '/one' },
        { id: 'two', name: 'Two', path: '/two' },
      ],
      activeProjectId: 'one',
      threads: [thread('active')],
    })
    let changes = 0
    const data = createThreadBrowserData(
      store,
      api,
      () => {
        changes += 1
      },
      () => clock,
    )
    const other = (): ThreadBrowserEntry | undefined =>
      data.entries().find((entry) => entry.thread.id === 'other')
    data.load()
    await delay(10)
    assert.equal(other()?.thread.title, 'before')
    title = 'after'
    clock += 30_000
    data.load()
    await delay(10)
    assert.equal(other()?.thread.title, 'before')
    clock += 31_000
    data.load()
    await delay(10)
    assert.equal(other()?.thread.title, 'after')
    const before = changes
    prRefsListener('two', [
      {
        threadId: 'other',
        prRefs: [
          {
            owner: 'copse-dev',
            repo: 'agent-pane',
            number: 7,
            url: 'https://github.com/copse-dev/agent-pane/pull/7',
          },
        ],
      },
    ])
    assert.equal(other()?.thread.prRefs?.[0]?.number, 7)
    assert.equal(changes, before + 1)
    data.dispose()
  })

  it('does not report failed reads as clean and stops queued work on disposal', async () => {
    const api = createFakeApi()
    const store = createStore({
      projects: [{ id: 'project', name: 'Project', path: '/project' }],
      activeProjectId: 'project',
      threads: [isolated('first'), isolated('second'), isolated('third')],
    })
    const reads: string[] = []
    api.git.status = async (_projectId, threadId): Promise<GitStatusResult> => {
      reads.push(threadId)
      await delay(10)
      throw new Error('Unavailable')
    }
    const data = createThreadBrowserData(store, api, () => {})
    data.inspect(data.entries())
    data.dispose()
    await delay(40)
    assert.deepEqual(reads, ['first', 'second'])
  })
})
