import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { beforeEach, it } from 'node:test'
import type { Thread } from '@shared/types/thread.ts'
import { createStore } from '@shared/store/store.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { restoreArchivedThread } from './thread-archive.ts'
import {
  __resetPersistenceForTest,
  attachAutosave,
  invalidateProjectThreadLoads,
  loadThreads,
} from './persistence.ts'
import { attachThreadHydration, ensureThreadMessages } from './thread-hydration.ts'

beforeEach(__resetPersistenceForTest)

function thread(): Thread {
  return {
    id: 'archived',
    title: 'Finished task',
    status: 'idle',
    createdAt: 1,
    updatedAt: 10,
    archivedAt: 10,
    messages: [
      {
        id: 'message',
        role: 'user',
        content: 'Preserved conversation',
        toolCalls: [],
        createdAt: 1,
      },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
  }
}

it('reloads a project response overtaken by an automatic archive', async () => {
  const api = createFakeApi()
  let release: (threads: Thread[]) => void = () => {}
  const stale = new Promise<Thread[]>((resolve) => {
    release = resolve
  })
  let requests = 0
  api.threads.loadProject = async (): Promise<Thread[]> => {
    requests++
    return requests === 1 ? stale : []
  }
  const pending = loadThreads(api, 'project')
  invalidateProjectThreadLoads(api, 'project')
  release([thread()])
  assert.deepEqual(await pending, [])
  assert.equal(requests, 2)
})

it('restores through main, opens the thread, and preserves a loaded transcript', async () => {
  const original = thread()
  const store = createStore({
    activeProjectId: 'project',
    expandedProjectId: 'project',
    threads: [original],
  })
  const api = createFakeApi()
  const calls: string[] = []
  api.threads.archiveDecision = async (pid, tid, decision): Promise<boolean> => {
    calls.push(`${pid}/${tid}/${decision}`)
    return true
  }
  api.threads.loadProject = async (): Promise<Thread[]> => {
    const restored = { ...original, updatedAt: 20, messages: [], messagesLoaded: false }
    delete restored.archivedAt
    return [restored]
  }
  await restoreArchivedThread(store, api, 'project', original.id)
  assert.deepEqual(calls, ['project/archived/restore'])
  assert.equal(store.getState().activeThreadId, original.id)
  assert.equal(store.getState().threads[0]?.archivedAt, undefined)
  assert.equal(store.getState().threads[0]?.updatedAt, 20)
  assert.equal(store.getState().threads[0]?.messages[0]?.content, 'Preserved conversation')
})

it('restores after restart without recreating the unloaded transcript', async (t) => {
  const original = thread()
  let savedMessages = original.messages
  let restored = false
  let creates = 0
  const api = createFakeApi()
  api.threads.archiveDecision = async (): Promise<boolean> => {
    restored = true
    return true
  }
  api.threads.loadProject = async (): Promise<Thread[]> => {
    if (!restored) return []
    const metadata = { ...original, messages: [], messagesLoaded: false, updatedAt: 20 }
    delete metadata.archivedAt
    return [metadata]
  }
  api.threads.create = async (_projectId, value): Promise<void> => {
    creates++
    savedMessages = value.messages
  }
  api.threads.loadMessages = async (): Promise<Thread['messages']> => savedMessages
  const store = createStore({
    activeProjectId: 'project',
    expandedProjectId: 'project',
    threads: await loadThreads(api, 'project'),
  })
  const autosave = attachAutosave(store, api)
  const detachHydration = attachThreadHydration(store, api)
  t.after(() => {
    autosave.detach()
    detachHydration()
  })
  await restoreArchivedThread(store, api, 'project', original.id)
  await autosave.flush()
  await ensureThreadMessages('project', original.id)
  assert.equal(creates, 0)
  assert.deepEqual(savedMessages, original.messages)
  assert.equal(store.getState().threads[0]?.messages[0]?.content, 'Preserved conversation')
})

it('a rejected Restore leaves the archive and current selection unchanged', async () => {
  const original = thread()
  const store = createStore({
    activeProjectId: 'project',
    activeThreadId: 'current',
    threads: [original],
  })
  const api = createFakeApi()
  api.threads.archiveDecision = async (): Promise<boolean> => false
  await assert.rejects(restoreArchivedThread(store, api, 'project', original.id), /busy or changed/)
  assert.equal(store.getState().activeThreadId, 'current')
  assert.equal(store.getState().threads[0]?.archivedAt, 10)
})
