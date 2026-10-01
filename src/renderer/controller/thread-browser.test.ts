import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { GitStatusResult } from '@shared/types/git.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { createThreadBrowserData } from './thread-browser.ts'

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
      threads: [thread('first'), thread('second'), thread('third'), thread('retired', true)],
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

  it('does not report failed reads as clean and stops queued work on disposal', async () => {
    const api = createFakeApi()
    const store = createStore({
      projects: [{ id: 'project', name: 'Project', path: '/project' }],
      activeProjectId: 'project',
      threads: [thread('first'), thread('second'), thread('third')],
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
