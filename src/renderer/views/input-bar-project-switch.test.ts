import '../../../tests/setup-dom.ts'
import { it } from 'node:test'
import assert from 'node:assert/strict'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { createStore } from '@shared/store/store.ts'
import { getThreadById } from '@shared/store/thread-helpers.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import {
  attachProjectThreadCache,
  resetProjectSwitchStateForTest,
  switchProjectAndWait,
} from '../controller/projects.ts'
import {
  __resetPersistenceForTest,
  attachAutosave,
  loadThreads,
} from '../controller/persistence.ts'
import { mountInputBar } from './input-bar.ts'

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: TestResizeObserver,
})

const DRAFT = 'Ask about the next release when I return.'
const NOTES = 'Keep writing the release notes.'

function savedThread(id: string, draftPrompt: string, status: 'idle' | 'running'): Thread {
  return {
    id,
    title: id,
    status,
    draftPrompt,
    createdAt: 1,
    updatedAt: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    messages: [
      {
        id: `${id}-user`,
        role: 'user',
        content: 'Check the release.',
        toolCalls: [],
        createdAt: 1,
      },
      {
        id: `${id}-reply`,
        role: 'assistant',
        content: 'Release checked.',
        toolCalls: [],
        createdAt: 2,
      },
    ],
  }
}

interface ComposerProjectFixture {
  api: ApiClient
  store: ReturnType<typeof createStore>
  disk: Map<string, Thread[]>
  autosave: ReturnType<typeof attachAutosave>
  composer: HTMLElement
  type: (text: string) => void
  holdDestinationRead: () => () => void
  assertNoDispatch: () => void
  dispose: () => void
}

async function fixture(status: 'idle' | 'running'): Promise<ComposerProjectFixture> {
  resetProjectSwitchStateForTest()
  __resetPersistenceForTest()
  const a = savedThread('release', '', status)
  const b = savedThread('notes', NOTES, 'idle')
  const disk = new Map<string, Thread[]>([
    ['a', [a]],
    ['b', [b]],
  ])
  let sends = 0
  let preparations = 0
  let readB: (() => Promise<Thread[]>) | undefined
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    workspace: { ...base.workspace, set: async (path): Promise<string> => path },
    agent: {
      ...base.agent,
      runningThreadIds: async (): Promise<string[]> => (status === 'running' ? [a.id] : []),
      run: async (): Promise<void> => {
        sends++
      },
      prepareCheckout: async () => {
        preparations++
        return { checkoutMode: 'shared', choice: 'automatic', branch: 'main' }
      },
    },
    threads: {
      ...base.threads,
      loadProject: async (id): Promise<Thread[]> =>
        id === 'b' && readB ? readB() : structuredClone(disk.get(id) ?? []),
      create: async (id, thread): Promise<void> => {
        disk.set(id, [
          ...(disk.get(id) ?? []).filter((t) => t.id !== thread.id),
          structuredClone(thread),
        ])
      },
      updateMeta: async (projectId, threadId, patch): Promise<void> => {
        disk.set(
          projectId,
          (disk.get(projectId) ?? []).map((t) =>
            t.id === threadId ? { ...t, ...structuredClone(patch) } : t,
          ),
        )
      },
      delete: async (projectId, threadId): Promise<void> => {
        disk.set(
          projectId,
          (disk.get(projectId) ?? []).filter((t) => t.id !== threadId),
        )
      },
    },
  }
  const store = createStore({
    projects: [
      { id: 'a', path: '/a', name: 'Release' },
      { id: 'b', path: '/b', name: 'Notes' },
    ],
    activeProjectId: 'a',
    expandedProjectId: 'a',
    workspaceRoot: '/a',
    activeThreadId: a.id,
    threads: await loadThreads(api, 'a'),
  })
  const detachCache = attachProjectThreadCache(store)
  const autosave = attachAutosave(store, api)
  const host = document.createElement('div')
  document.body.append(host)
  const bar = mountInputBar(host, store, api)
  const composer = host.querySelector<HTMLElement>('.prompt-input')
  assert.ok(composer)
  return {
    api,
    store,
    disk,
    autosave,
    composer,
    type(text: string): void {
      composer.textContent = text
      composer.dispatchEvent(new Event('input', { bubbles: true }))
    },
    holdDestinationRead(): () => void {
      let resolve: (threads: Thread[]) => void = () => {}
      const pending = new Promise<Thread[]>((done) => {
        resolve = done
      })
      readB = (): Promise<Thread[]> => pending
      return (): void => {
        resolve(structuredClone(disk.get('b') ?? []))
      }
    },
    assertNoDispatch(): void {
      assert.equal(sends, 0)
      assert.equal(preparations, 0)
    },
    dispose(): void {
      bar.unmount()
      autosave.detach()
      detachCache()
      host.remove()
    },
  }
}

for (const status of ['idle', 'running'] as const) {
  for (const resident of [false, true]) {
    it(`persists actual composer input before switching projects (${status}, resident=${String(resident)})`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const f = await fixture(status)
      try {
        if (resident) {
          await switchProjectAndWait(f.store, f.api, 'b')
          await switchProjectAndWait(f.store, f.api, 'a')
        }
        const originalMessages = structuredClone(f.disk.get('a')?.[0]?.messages)
        f.type(DRAFT)
        await switchProjectAndWait(f.store, f.api, 'b')
        assert.equal(f.composer.textContent, NOTES)
        // Ordinary teardown must preserve the other project's draft too.
        window.dispatchEvent(new Event('pagehide'))
        await f.autosave.whenIdle()
        assert.equal(f.disk.get('a')?.[0]?.draftPrompt, DRAFT)
        assert.equal(f.disk.get('b')?.[0]?.draftPrompt, NOTES)
        assert.deepEqual(f.disk.get('a')?.[0]?.messages, originalMessages)
        if (status === 'running')
          assert.equal(getThreadById(f.store, 'release')?.draftPrompt, DRAFT)
        f.assertNoDispatch()
      } finally {
        f.dispose()
      }
    })
  }

  it(`captures composer edits made while the destination loads (${status})`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const f = await fixture(status)
    try {
      const release = f.holdDestinationRead()
      const switched = switchProjectAndWait(f.store, f.api, 'b')
      assert.equal(f.store.getState().activeProjectId, 'a')
      f.type(DRAFT)
      release()
      await switched
      window.dispatchEvent(new Event('pagehide'))
      await f.autosave.whenIdle()
      assert.equal(f.disk.get('a')?.[0]?.draftPrompt, DRAFT)
      assert.equal(f.disk.get('b')?.[0]?.draftPrompt, NOTES)
      f.assertNoDispatch()
    } finally {
      f.dispose()
    }
  })
}
