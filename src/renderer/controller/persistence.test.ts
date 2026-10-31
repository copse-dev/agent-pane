import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expectRecord } from '@shared/unknown-value.ts'
import {
  serializedSet,
  afterThreadWrites,
  attachAutosave,
  flushProjectThreads,
  loadThreads,
  loadPersistedThread,
  invalidateProjectThreadLoads,
  acceptRuntimeThreadMeta,
  awaitPendingThreadPersistence,
  __resetPersistenceForTest,
  saveProjects,
  saveNavigation,
  setNavigationOwnership,
  markNavigationRestored,
  suspendNavigationWrites,
  AUTOSAVE_DEBOUNCE_MS,
} from './persistence.ts'
import { createStore } from '@shared/store/store.ts'
import { transcriptMeta } from '@shared/store/transcript-state.ts'
import type {
  Message,
  ReviewFindingRecord,
  StreamChunk,
  Thread,
  ThreadReviewReport,
} from '@shared/types'
import { createHash } from 'node:crypto'
import { explodeMessage, foldMessage } from '@shared/threads/fold.ts'
import { parseMessageValue, parseThreadValue } from '@shared/threads/thread-boundary.ts'
import { parseSpine, serializeSpineLine } from '@shared/threads/spine-schema.ts'
import { startAgentController } from './agent.ts'
import { attachThreadHydration, ensureThreadMessages } from './thread-hydration.ts'
import { __resetRuntimeTranscriptForTest, applyRuntimeOwnedChunk } from './runtime-transcript.ts'
import { dismissReviewFinding, dismissReviewReport, startReview } from './review-actions.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { optionalRecord } from '@shared/unknown-value.ts'
import { startProposedThread } from './thread-proposals.ts'
import {
  createThread,
  isBlankThread,
  markThreadHasSavedPlan,
  normalizeBlankThreads,
  switchThread,
} from '@shared/store/thread-helpers.ts'

// attachAutosave registers a pagehide listener; provide a minimal window stub
// (node test env has no DOM).
const pagehideHandlers = new Set<() => void>()
;(globalThis as Record<string, unknown>)['window'] = {
  addEventListener: (event: string, handler: () => void): void => {
    if (event === 'pagehide') pagehideHandlers.add(handler)
  },
  removeEventListener: (event: string, handler: () => void): void => {
    if (event === 'pagehide') pagehideHandlers.delete(handler)
  },
}

interface FakeApiCalls {
  storageSets: Array<[string, unknown]>
  navigations: import('@shared/types/main-window.ts').MainWindowNavigation[]
  creates: Array<{ projectId: string; thread: Thread }>
  appends: Array<{ projectId: string; threadId: string; message: Message }>
  metas: Array<{ projectId: string; threadId: string; patch: unknown }>
  deletes: Array<{ projectId: string; threadId: string }>
}

function fakeApi(
  handlers: {
    set?: (key: string, value: unknown) => Promise<void>
    create?: (projectId: string, thread: Thread) => Promise<void>
    updateMeta?: (projectId: string, threadId: string, patch: unknown) => Promise<void>
    delete?: (projectId: string, threadId: string) => Promise<void>
  } = {},
): { api: ApiClient; calls: FakeApiCalls } {
  const calls: FakeApiCalls = {
    storageSets: [],
    navigations: [],
    creates: [],
    appends: [],
    metas: [],
    deletes: [],
  }
  const api = ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      windowState: {
        ...base['windowState'],
        setNavigation: async (navigation): Promise<void> => {
          calls.navigations.push(structuredClone(navigation))
        },
      },
      storage: {
        ...base['storage'],
        get: async (): Promise<unknown> => null,
        set:
          handlers.set ??
          (async (key, value): Promise<void> => {
            calls.storageSets.push([key, value])
          }),
      },
      threads: {
        ...base['threads'],
        loadProject: async (): Promise<Thread[]> => [],
        create:
          handlers.create ??
          (async (projectId: string, thread: Thread): Promise<void> => {
            calls.creates.push({ projectId, thread })
          }),
        appendMessage: async (
          projectId: string,
          threadId: string,
          message: Message,
        ): Promise<void> => {
          calls.appends.push({ projectId, threadId, message })
        },
        updateMeta:
          handlers.updateMeta ??
          (async (projectId: string, threadId: string, patch: unknown): Promise<void> => {
            calls.metas.push({ projectId, threadId, patch })
          }),
        delete:
          handlers.delete ??
          (async (projectId: string, threadId: string): Promise<void> => {
            calls.deletes.push({ projectId, threadId })
          }),
        catalog: async (): Promise<never[]> => [],
      },
    } satisfies ApiClient
  })()
  return { api, calls }
}

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

async function seedPersistedThread(projectId: string, value: Thread): Promise<void> {
  const api = createFakeApi()
  api.threads.loadProject = async (): Promise<Thread[]> => [value]
  await loadPersistedThread(api, projectId, value.id)
}

function userMsg(id: string): Message {
  return { id, role: 'user', content: 'hi', toolCalls: [], createdAt: 10 }
}

const tick = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0))
const waitDebounce = (): Promise<unknown> =>
  new Promise((r) => setTimeout(r, AUTOSAVE_DEBOUNCE_MS + 20))

test('serializedSet applies writes to the same key in submission order', async () => {
  const calls: Array<[string, unknown]> = []
  const resolvers: Array<() => void> = []
  const { api } = fakeApi({
    set: (key, value) => {
      calls.push([key, value])
      return new Promise<void>((r) => resolvers.push(r))
    },
  })

  const p1 = serializedSet(api, 'k', 'first')
  const p2 = serializedSet(api, 'k', 'second')

  await tick()
  assert.deepEqual(calls, [['k', 'first']])

  const resolveFirst = resolvers[0]
  assert.ok(resolveFirst, 'first resolver should be registered')
  resolveFirst()
  await p1
  await tick()
  assert.deepEqual(calls, [
    ['k', 'first'],
    ['k', 'second'],
  ])

  const resolveSecond = resolvers[1]
  assert.ok(resolveSecond, 'second resolver should be registered')
  resolveSecond()
  await p2
})

test('serializedSet does not serialize across different keys', async () => {
  const calls: string[] = []
  const { api } = fakeApi({
    set: (key) => {
      calls.push(key)
      return Promise.resolve()
    },
  })
  await Promise.all([serializedSet(api, 'a', 1), serializedSet(api, 'b', 2)])
  assert.deepEqual([...calls].sort(), ['a', 'b'])
})

test('creates a new thread immediately on threads_changed (before prepareCheckout)', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const store = createStore({ activeProjectId: 'p1', threads: [thread('t1')], projects: [] })
  const autosave = attachAutosave(store, api)

  store.emit('threads_changed')

  // Must not wait for AUTOSAVE_DEBOUNCE_MS — first send prepares checkout
  // against main before any message_added reconcile can create the thread.
  assert.deepEqual(
    calls.creates.map((c) => [c.projectId, c.thread.id]),
    [['p1', 't1']],
  )
  assert.deepEqual(calls.metas, [])
  autosave.detach()
})

test('debounces a metadata burst into one projects save after the immediate create', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const store = createStore({ activeProjectId: 'p1', threads: [thread('t1')], projects: [] })
  const autosave = attachAutosave(store, api)

  store.emit('threads_changed')
  assert.equal(calls.creates.length, 1)

  store.emit('usage_updated', 't1')
  store.emit('todos_changed', 't1')
  store.emit('projects_changed')

  assert.deepEqual(calls.storageSets.map((c) => c[0]).sort(), [])

  await waitDebounce()

  assert.equal(calls.creates.length, 1)
  assert.deepEqual(calls.metas, [])
  assert.deepEqual(
    calls.storageSets.map((call) => call[0]),
    ['projects'],
  )
  assert.deepEqual(calls.navigations.at(-1), {
    activeProjectId: 'p1',
    activeThreadId: null,
  })
  autosave.detach()
})

test('a window that does not own navigation persists projects but never navigation', async () => {
  // A pane pop-out boots this renderer and restores the same project, but the
  // main process rejects `setNavigation` from any window that is not a
  // registered full main window. Sending it anyway rejected mid-`restoreProject`
  // and took the `workspace_changed` emit with it, so the detached pane came up
  // empty. Projects still save — only the navigation half is withheld.
  __resetPersistenceForTest()
  setNavigationOwnership(false)
  const popout = fakeApi()

  await saveProjects(popout.api, [], 'p1', 't1')
  assert.equal(popout.calls.navigations.length, 0, 'a pop-out must not write navigation')
  assert.deepEqual(
    popout.calls.storageSets.map((call) => call[0]),
    ['projects'],
    'the projects list is shared state and still saves',
  )

  // Ownership is per-window, so a main window is unaffected. Its own fake API,
  // deliberately: asserting `deepEqual(navigations, [])` above would narrow the
  // shared object to `never[]` and make every later read of it statically
  // `undefined` — passing at runtime while the types describe a different test.
  __resetPersistenceForTest()
  const main = fakeApi()
  const store = createStore({ activeProjectId: 'p1', threads: [thread('t1')], projects: [] })
  const autosave = attachAutosave(store, main.api)
  store.emit('projects_changed')
  await waitDebounce()
  assert.deepEqual(main.calls.navigations.at(-1), { activeProjectId: 'p1', activeThreadId: null })
  autosave.detach()
})

test('does not rewrite a projects list that has not changed', async () => {
  // Each `storage:set` rewrites the whole config.json synchronously on the main
  // thread, and a project switch emits `projects_changed` several times. An
  // unchanged list is only ever written once.
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const projects = [{ id: 'p1', path: '/p1', name: 'P1' }]

  await saveProjects(api, projects, 'p1', null)
  await saveProjects(api, projects, 'p1', 't1')
  await saveProjects(api, structuredClone(projects), 'p1', 't1')
  assert.deepEqual(
    calls.storageSets.map((call) => call[0]),
    ['projects'],
    'an identical list is written once, however many times it is saved',
  )

  const renamed = [{ id: 'p1', path: '/p1', name: 'Renamed' }]
  await saveProjects(api, renamed, 'p1', 't1')
  assert.equal(calls.storageSets.length, 2, 'a changed list is still written')
  assert.deepEqual(calls.storageSets.at(-1), ['projects', renamed])
})

test('autosave does not rewrite projects on a projects_changed that changed nothing', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const projects = [{ id: 'p1', path: '/p1', name: 'P1' }]
  const store = createStore({ activeProjectId: 'p1', threads: [], projects })
  markNavigationRestored({ activeProjectId: 'p1', activeThreadId: null })
  const autosave = attachAutosave(store, api)

  // `projects_changed` is also the sidebar's re-render signal.
  store.emit('projects_changed')
  await waitDebounce()
  store.emit('projects_changed')
  await waitDebounce()
  assert.equal(calls.storageSets.filter((call) => call[0] === 'projects').length, 1)

  store.setState({ projects: [{ id: 'p1', path: '/p1', name: 'Renamed' }] })
  store.emit('projects_changed')
  await waitDebounce()
  assert.equal(calls.storageSets.filter((call) => call[0] === 'projects').length, 2)
  autosave.detach()
})

test('a failed projects write is retried instead of skipped as already persisted', async () => {
  __resetPersistenceForTest()
  let failNext = true
  const attempts: unknown[] = []
  const { api } = fakeApi({
    set: async (_key, value): Promise<void> => {
      attempts.push(value)
      if (failNext) {
        failNext = false
        throw new Error('disk full')
      }
    },
  })
  const projects = [{ id: 'p1', path: '/p1', name: 'P1' }]

  await assert.rejects(() => saveProjects(api, projects, 'p1', null), /disk full/)
  await saveProjects(api, projects, 'p1', null)
  assert.equal(attempts.length, 2, 'the retry reaches storage')
})

test('does not persist navigation before boot has restored it', async () => {
  // `attachAutosave` is attached long before `loadProjects` resolves. Until the
  // restored value is in the store, `activeProjectId` reads as null, and writing
  // that back overwrote the window's record and the legacy mirror — leaving a
  // window that lists its projects with none of them active (the SSH disconnect
  // banner short-circuits on `!activeProjectId` and never renders).
  __resetPersistenceForTest()
  suspendNavigationWrites()
  const { api, calls } = fakeApi()
  const store = createStore({ activeProjectId: null, threads: [], projects: [] })
  const autosave = attachAutosave(store, api)

  store.emit('projects_changed')
  await waitDebounce()
  assert.equal(calls.navigations.length, 0, 'a pre-restore flush must not write navigation')

  // Boot restores, and from then on the real value is persisted.
  markNavigationRestored({ activeProjectId: null, activeThreadId: null })
  store.setState({ activeProjectId: 'p1' })
  store.emit('projects_changed')
  await waitDebounce()
  assert.deepEqual(calls.navigations.at(-1), { activeProjectId: 'p1', activeThreadId: null })
  autosave.detach()
})

test('does not rewrite navigation that has not changed', async () => {
  // `flushNow` writes navigation on every flush, and one of those is the
  // `pagehide` fired while the window is being torn down — which in e2e happens
  // *after* the next fixture has seeded config.json. Writing an unchanged value
  // there put the dying window's project back over the seed, so the next launch
  // booted with no active project (and the SSH banner, gated on
  // `activeProjectId`, never rendered).
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const store = createStore({ activeProjectId: 'p1', threads: [], projects: [] })
  markNavigationRestored({ activeProjectId: 'p1', activeThreadId: null })
  const autosave = attachAutosave(store, api)

  store.emit('projects_changed')
  await waitDebounce()
  assert.equal(calls.navigations.length, 0, 'an unchanged navigation must not be written')

  // A real navigation change still lands.
  store.setState({ activeProjectId: 'p2' })
  store.emit('projects_changed')
  await waitDebounce()
  assert.deepEqual(calls.navigations.at(-1), { activeProjectId: 'p2', activeThreadId: null })
  autosave.detach()
})

test('an identical navigation save waits for the outstanding IPC write', async () => {
  __resetPersistenceForTest()
  const { api } = fakeApi()
  let release = (): void => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let writes = 0
  api.windowState.setNavigation = async (): Promise<void> => {
    writes++
    await pending
  }
  const first = saveNavigation(api, 'p2', null)
  let duplicateFinished = false
  const duplicate = saveProjects(api, [], 'p2', null).then(() => {
    duplicateFinished = true
  })
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(duplicateFinished, false, 'project activation must wait for navigation to land')
    assert.equal(writes, 1, 'the identical navigation must reuse the outstanding write')
  } finally {
    release()
    await Promise.all([first, duplicate])
  }
  assert.equal(duplicateFinished, true)
})

test('a metadata change on a known thread emits updateMeta, not create', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const store = createStore({ activeProjectId: 'p1', threads: [thread('t1')], projects: [] })
  const autosave = attachAutosave(store, api)

  // First reconcile establishes the baseline (create t1).
  store.emit('threads_changed')
  await waitDebounce()
  assert.equal(calls.creates.length, 1)

  // Change the draft, then reconcile again — meta changed, id known → updateMeta.
  store.setState({ threads: [thread('t1', { draftPrompt: 'typing' })] })
  store.emit('thread_draft_changed', 't1')
  await waitDebounce()

  assert.equal(calls.creates.length, 1) // unchanged
  assert.deepEqual(
    calls.metas.map((m) => [m.threadId, expectRecord(m.patch)['draftPrompt']]),
    [['t1', 'typing']],
  )
  autosave.detach()
})

test('a meta patch carries only changed keys, never stale copies of main-written fields', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const prRef = {
    owner: 'acme',
    repo: 'widgets',
    number: 1,
    url: 'https://github.com/acme/widgets/pull/1',
  }
  const loaded = thread('t1', {
    prRefs: [prRef],
    remoteAgentLink: { provider: 'cursor', agentId: 'agent', createdAt: 1 },
    modelSelections: [{ id: 's1', recordedAt: 1, by: 'user', to: 'model-a' }],
  })
  const store = createStore({ activeProjectId: 'p1', threads: [loaded], projects: [] })
  const autosave = attachAutosave(store, api)
  store.emit('threads_changed')
  await waitDebounce()

  // Main has since appended a model selection / PR ref on disk; the renderer's
  // copies are stale. A draft keystroke must not send them back.
  store.setState({ threads: [{ ...loaded, draftPrompt: 'typing' }] })
  store.emit('thread_draft_changed', 't1')
  await waitDebounce()

  const patch = expectRecord(calls.metas.at(-1)?.patch)
  assert.deepEqual(Object.keys(patch), ['draftPrompt'])
  assert.equal(patch['draftPrompt'], 'typing')
  autosave.detach()
})

test('saving a plan prevents autosave deletion without persisting its derived retention flag', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const store = createStore({
    activeProjectId: 'p1',
    activeThreadId: 'plan',
    threads: [thread('plan'), thread('other', { messages: [userMsg('u1')] })],
  })
  const autosave = attachAutosave(store, api)
  store.emit('threads_changed')
  await awaitPendingThreadPersistence()
  markThreadHasSavedPlan(store, 'plan')
  switchThread(store, 'other')
  await waitDebounce()
  assert.deepEqual(calls.deletes, [])
  assert.deepEqual(calls.metas, [], 'derived plan presence is not mutable thread metadata')
  assert.ok(store.getState().threads.some((item) => item.id === 'plan'))
  autosave.detach()
})

test('clearing an optional field sends an explicit undefined so it is deleted on disk', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const queued = {
    messageId: 'q1',
    payload: { content: 'later', invokedSkills: [], priorTodos: [] },
    createdAt: 5,
  }
  const store = createStore({
    activeProjectId: 'p1',
    threads: [thread('t1', { pendingMessages: [queued], queuePaused: true })],
    projects: [],
  })
  const autosave = attachAutosave(store, api)

  // Baseline: create t1 with a pending message.
  store.emit('threads_changed')
  await waitDebounce()
  assert.equal(calls.creates.length, 1)

  // Drain the queue: the thread object drops both keys entirely (not [] / false).
  store.setState({ threads: [thread('t1')] })
  store.emit('threads_changed')
  await waitDebounce()

  const patch = optionalRecord(calls.metas.at(-1)?.patch)
  assert.ok(patch, 'a meta patch should be emitted')
  // The removed keys are present with `undefined` so the on-disk merge clears
  // them, rather than absent (which would let the stale value linger).
  assert.ok('pendingMessages' in patch)
  assert.equal(patch['pendingMessages'], undefined)
  assert.ok('queuePaused' in patch)
  assert.equal(patch['queuePaused'], undefined)
  autosave.detach()
})

test('clearing a comparison persists via comparison_changed with an explicit undefined', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const comparison = {
    status: 'error' as const,
    models: { a: 'model-a', b: 'model-b', judge: 'model-j' },
    reviewA: '',
    reviewB: '',
    synthesis: '',
    error: 'Comparison declined.',
  }
  const store = createStore({
    activeProjectId: 'p1',
    threads: [thread('t1', { comparison })],
    projects: [],
  })
  const autosave = attachAutosave(store, api)

  // Baseline: create t1 with the failed comparison.
  store.emit('threads_changed')
  await waitDebounce()
  assert.equal(calls.creates.length, 1)

  // Dismiss: the thread drops the key entirely; only comparison_changed fires
  // (the thread is idle, so no other autosave trigger accompanies it).
  store.setState({ threads: [thread('t1')] })
  store.emit('comparison_changed', 't1')
  await waitDebounce()

  const patch = optionalRecord(calls.metas.at(-1)?.patch)
  assert.ok(patch, 'a meta patch should be emitted')
  assert.ok('comparison' in patch)
  assert.equal(patch['comparison'], undefined)
  autosave.detach()
})

test('a finalized message is appended immediately on message_done', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const store = createStore({
    activeProjectId: 'p1',
    activeThreadId: 't1',
    threads: [thread('t1', { messages: [userMsg('m1')] })],
    projects: [],
  })
  const autosave = attachAutosave(store, api)

  store.emit('message_done', 'm1')
  await tick()

  assert.deepEqual(
    calls.appends.map((a) => [a.projectId, a.threadId, a.message.id]),
    [['p1', 't1', 'm1']],
  )
  autosave.detach()
})

test('a carried background run finalizing appends into its own project, without reconcile', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  // The user is on p2; the run's thread was carried when p1 was switched away.
  const store = createStore({
    activeProjectId: 'p2',
    activeThreadId: 't2',
    threads: [thread('t2')],
    projects: [],
  })
  store.setState({
    backgroundThreads: [
      {
        projectId: 'p1',
        thread: thread('t1', { status: 'running', messages: [userMsg('m1')] }),
      },
    ],
  })
  const autosave = attachAutosave(store, api)

  store.emit('message_done', 'm1')
  await tick()

  assert.deepEqual(
    calls.appends.map((a) => [a.projectId, a.threadId, a.message.id]),
    [['p1', 't1', 'm1']],
  )
  // No reconcile ran for p1: reconciling a background project against the
  // active project's thread list would read its threads as deleted (#1841).
  assert.deepEqual(calls.creates, [])
  assert.deepEqual(calls.deletes, [])
  autosave.detach()
})

test('a settled ACP tool update re-finalizes its message with the latest args and response', async () => {
  __resetPersistenceForTest()
  const running: Message = {
    id: 'a1',
    role: 'assistant',
    content: '',
    createdAt: 20,
    toolCalls: [
      {
        id: 'acp1',
        name: 'mcp.copse.run_shell',
        args: { command: 'npm test' },
        kind: 'execute',
        status: 'running',
        result: 'starting',
        resultFormat: 'markdown',
      },
    ],
  }
  const { api, calls } = fakeApi()
  const store = createStore({
    activeProjectId: 'p1',
    activeThreadId: 't1',
    threads: [thread('t1', { messages: [running] })],
    projects: [],
  })
  const autosave = attachAutosave(store, api)

  // A running patch must not be serialized as the v1 spine's terminal `done`.
  store.emit('tool_call_updated', running.id, 'acp1')
  await tick()
  assert.equal(calls.appends.length, 0)

  const settled: Message = {
    ...running,
    toolCalls: running.toolCalls.map((toolCall) => ({
      ...toolCall,
      status: 'done' as const,
      result: 'all tests passed',
    })),
  }
  store.setState({ threads: [thread('t1', { messages: [settled] })] })
  store.emit('tool_call_updated', settled.id, 'acp1')
  await tick()

  assert.equal(calls.appends.length, 1)
  assert.deepEqual(calls.appends[0], {
    projectId: 'p1',
    threadId: 't1',
    message: settled,
  })
  autosave.detach()
})

test('a re-persisted message keeps its original createdAt, not the write time (#1411)', async () => {
  __resetPersistenceForTest()
  // The message "occurred" several minutes before this test runs. A live
  // assistant bubble is stamped once, at creation, in `addMessage`
  // (`src/shared/store/thread-helpers.ts`) — persistence must ship that same
  // value on every write, including a later re-persist, rather than a fresh
  // `Date.now()` taken when the write actually goes out.
  const occurredAt = Date.now() - 5 * 60_000
  const running: Message = {
    id: 'a1',
    role: 'assistant',
    content: 'looking into it',
    createdAt: occurredAt,
    toolCalls: [
      { id: 'tc1', name: 'read_file', args: { path: 'x' }, status: 'running', result: null },
    ],
  }
  const { api, calls } = fakeApi()
  const store = createStore({
    activeProjectId: 'p1',
    activeThreadId: 't1',
    threads: [thread('t1', { messages: [running] })],
    projects: [],
  })
  const autosave = attachAutosave(store, api)
  const runningTool = running.toolCalls[0]
  assert.ok(runningTool)

  // First finalize: the turn's `message_done`.
  store.emit('message_done', 'a1')
  await tick()

  // A later re-persist — mirroring a delayed ACP tool update arriving well
  // after the original write — must not stamp the write-time instead.
  const settled: Message = {
    ...running,
    toolCalls: [{ ...runningTool, status: 'done', result: 'contents' }],
  }
  store.setState({ threads: [thread('t1', { messages: [settled] })] })
  store.emit('tool_call_updated', 'a1', 'tc1')
  await tick()

  assert.equal(calls.appends.length, 2)
  for (const append of calls.appends) {
    assert.equal(append.message.createdAt, occurredAt)
    assert.notEqual(append.message.createdAt, Date.now())
  }
  autosave.detach()
})

test('a new user message sends thread creation before an agent run can be dispatched', async () => {
  __resetPersistenceForTest()
  const message = userMsg('m1')
  const { api, calls } = fakeApi()
  const store = createStore({
    activeProjectId: 'p1',
    activeThreadId: 't1',
    threads: [thread('t1', { messages: [message] })],
    projects: [],
  })
  const autosave = attachAutosave(store, api)

  store.emit('message_added', 't1', message.id)

  assert.deepEqual(
    calls.creates.map((entry) => [entry.projectId, entry.thread.id]),
    [['p1', 't1']],
  )
  await tick()
  assert.deepEqual(
    calls.appends.map((entry) => [entry.projectId, entry.threadId, entry.message.id]),
    [['p1', 't1', 'm1']],
  )
  autosave.detach()
})

test('a removed thread emits delete', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const store = createStore({
    activeProjectId: 'p1',
    threads: [thread('t1'), thread('t2')],
    projects: [],
  })
  const autosave = attachAutosave(store, api)

  store.emit('threads_changed')
  await waitDebounce()
  assert.equal(calls.creates.length, 2)

  store.setState({ threads: [thread('t1')] })
  store.emit('threads_changed')
  await waitDebounce()

  assert.deepEqual(
    calls.deletes.map((d) => [d.projectId, d.threadId]),
    [['p1', 't2']],
  )
  autosave.detach()
})

test('skips stale writes for a thread gone after a project switch', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const store = createStore({
    activeProjectId: 'p1',
    activeThreadId: 'old',
    threads: [thread('old', { messages: [userMsg('m-old')] })],
    projects: [],
  })
  const autosave = attachAutosave(store, api)

  store.emit('usage_updated', 'old')
  // Switch projects before the debounce fires.
  store.setState({ activeProjectId: 'p2', threads: [thread('new')], activeThreadId: 'new' })
  await waitDebounce()

  // Nothing is written for the outgoing 'old' thread under any project.
  assert.equal(
    calls.creates.some((c) => c.thread.id === 'old'),
    false,
  )
  assert.equal(
    calls.metas.some((m) => m.threadId === 'old'),
    false,
  )
  assert.equal(
    calls.appends.some((a) => a.threadId === 'old'),
    false,
  )
  autosave.detach()
})

test('flush() awaits an in-flight new-thread create started by threads_changed', async () => {
  __resetPersistenceForTest()
  let resolved = false
  const { api } = fakeApi({
    create: () =>
      new Promise<void>((r) =>
        setTimeout(() => {
          resolved = true
          r()
        }, 10),
      ),
  })
  const store = createStore({ activeProjectId: 'p1', threads: [thread('t1')], projects: [] })
  const autosave = attachAutosave(store, api)

  try {
    store.emit('threads_changed')
    await autosave.flush()
    assert.equal(resolved, true)
  } finally {
    autosave.detach()
  }
})

test('awaitPendingThreadPersistence waits for the immediate new-thread create', async () => {
  __resetPersistenceForTest()
  let resolved = false
  const { api } = fakeApi({
    create: () =>
      new Promise<void>((r) =>
        setTimeout(() => {
          resolved = true
          r()
        }, 10),
      ),
  })
  const store = createStore({ activeProjectId: 'p1', threads: [thread('t1')], projects: [] })
  const autosave = attachAutosave(store, api)

  try {
    store.emit('threads_changed')
    assert.equal(resolved, false)
    await awaitPendingThreadPersistence()
    assert.equal(resolved, true)
  } finally {
    autosave.detach()
  }
})

test('awaitPendingThreadPersistence is a no-op when autosave is not attached', async () => {
  __resetPersistenceForTest()
  await awaitPendingThreadPersistence()
})

test('a proposed thread waits for its create before preparing the checkout', async () => {
  __resetPersistenceForTest()
  const persisted = new Set<string>()
  let releaseCreate = (): void => undefined
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve
  })
  const { api } = fakeApi({
    create: async (_projectId, created) => {
      await createGate
      persisted.add(created.id)
    },
  })
  const store = createStore({ activeProjectId: 'p1', threads: [thread('source')], projects: [] })
  const autosave = attachAutosave(store, api)
  let prepared = false
  try {
    const starting = startProposedThread(
      store,
      {
        agent: {
          ...api.agent,
          prepareCheckout: async (_projectId, id) => {
            assert.ok(persisted.has(id), 'checkout must not race the new thread create')
            prepared = true
            return { checkoutMode: 'shared', choice: 'worktree', branch: null }
          },
        },
      },
      'source',
      { id: 'proposal', title: 'Follow-up', summary: 'Separate work', prompt: 'Check it' },
      {
        confirmSharedCheckout: () => Promise.resolve(false),
      },
    )
    await tick()
    assert.equal(prepared, false)
    releaseCreate()
    assert.equal((await starting).started, false)
    assert.equal(prepared, true)
  } finally {
    releaseCreate()
    autosave.detach()
  }
})

test('pagehide flush triggers a final reconcile', async () => {
  __resetPersistenceForTest()
  pagehideHandlers.clear()
  const { api, calls } = fakeApi()
  const store = createStore({ activeProjectId: 'p1', threads: [thread('t1')], projects: [] })
  const autosave = attachAutosave(store, api)

  try {
    pagehideHandlers.forEach((h) => {
      h()
    })
    await tick()
    assert.deepEqual(
      calls.creates.map((c) => c.thread.id),
      ['t1'],
    )
  } finally {
    autosave.detach()
  }
})

test('a standalone review report and its dismissals reach the reviewed message on disk', async () => {
  __resetPersistenceForTest()
  const { api: base, calls } = fakeApi()
  let send: ((threadId: string, chunk: StreamChunk) => void) | null = null
  const api: ApiClient = {
    ...base,
    agent: {
      ...base.agent,
      onChunk: (handler: (threadId: string, chunk: StreamChunk) => void) => {
        send = handler
        return (): void => {}
      },
      onHookQueueMessage: () => (): void => {},
    },
    review: {
      run: async (): Promise<void> => {},
      dismissFinding: async (): Promise<void> => {},
      restoreFinding: async (): Promise<void> => {},
    },
  }
  const assistant: Message = {
    id: 'a1',
    role: 'assistant',
    content: 'Changed math.ts',
    toolCalls: [],
    createdAt: 20,
  }
  const store = createStore({
    activeProjectId: 'p1',
    activeThreadId: 't1',
    threads: [thread('t1', { messages: [userMsg('u1'), assistant] })],
    projects: [],
  })
  const autosave = attachAutosave(store, api)
  const stopAgent = startAgentController(store, api)
  const emit = (chunk: StreamChunk): void => {
    assert.ok(send)
    send('t1', chunk)
  }
  const finding: ReviewFindingRecord = {
    id: '0123456789abcdef',
    path: 'src/math.ts',
    startLine: 3,
    claim: 'add subtracts its second argument.',
    class: 'contract',
    severity: 'high',
    confidence: 'high',
    verdict: { status: 'confirmed', reason: 'The reproducer fails on head and passes on base.' },
    raisedBy: ['gpt-5 (correctness)'],
    corroboratedBy: [],
    challengedBy: [],
    evidence: [],
  }
  const appendsOf = (id: string): Message[] =>
    calls.appends.filter((a) => a.message.id === id).map((a) => a.message)
  try {
    // The Changes view "Review" button: optimistic card, then main's chunks.
    startReview(store, api, 't1')
    const running = store.getState().threads[0]?.messages[1]?.reviewReport
    assert.ok(running?.status === 'running')
    emit({ type: 'review_report', report: running })
    await tick()
    // A spinning card is never written: a crash must not leave it running.
    assert.deepEqual(appendsOf('a1'), [])

    const done: ThreadReviewReport = { ...running, status: 'done', findings: [finding] }
    emit({ type: 'review_report', report: done })
    emit({ type: 'done' })
    await tick()
    const persisted = appendsOf('a1').at(-1)
    assert.deepEqual(persisted?.reviewReport, done)

    // Reload: the IPC boundary parse, the spine line, and the fold keep it.
    const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
    const reload = (message: Message | undefined): Message => {
      const parsed = parseMessageValue(structuredClone(message))
      assert.ok(parsed)
      const { line, files } = explodeMessage(parsed, hash)
      const [spineLine] = parseSpine(serializeSpineLine(line))
      assert.ok(spineLine)
      const contents = new Map(files.map((file) => [file.ref, file.contents]))
      return foldMessage(
        spineLine,
        (ref) => {
          const text = contents.get(ref)
          if (text === undefined) throw new Error(`missing ref ${ref}`)
          return text
        },
        { hash },
      )
    }
    assert.deepEqual(reload(persisted).reviewReport, done)

    dismissReviewFinding(store, api, 't1', finding, 'a1')
    await tick()
    assert.equal(reload(appendsOf('a1').at(-1)).reviewReport?.findings[0]?.dismissed, true)

    dismissReviewReport(store, 't1', 'a1')
    await tick()
    assert.equal(reload(appendsOf('a1').at(-1)).reviewReport, undefined)
  } finally {
    stopAgent()
    autosave.detach()
  }
})

test('store events from a stamped chunk write nothing; main owns that transcript', async () => {
  __resetPersistenceForTest()
  __resetRuntimeTranscriptForTest()
  const { api, calls } = fakeApi()
  const assistant: Message = {
    id: 'a1',
    role: 'assistant',
    content: 'done',
    toolCalls: [{ id: 'tc1', name: 'read_file', args: {}, status: 'done', result: 'ok' }],
    createdAt: 20,
  }
  const store = createStore({
    activeProjectId: 'p1',
    activeThreadId: 't1',
    threads: [thread('t1', { messages: [userMsg('m1'), assistant] })],
    projects: [],
  })
  const autosave = attachAutosave(store, api)

  applyRuntimeOwnedChunk(['a1'], () => {
    store.emit('message_done', 'a1')
    store.emit('tool_call_updated', 'a1', 'tc1')
    store.emit('review_report_changed', 't1', 'a1')
  })
  // A summary label resolving later on a main-owned message goes to main.
  store.emit('tool_call_updated', 'a1', '')
  await tick()
  assert.equal(calls.appends.length, 0, 'main owns these writes')

  // A message main does not own is still the window's to write.
  store.emit('message_done', 'm1')
  await tick()
  assert.deepEqual(
    calls.appends.map((append) => append.message.id),
    ['m1'],
  )
  autosave.detach()
})

test('runtime metadata does not autosave back, while a simultaneous user edit still does', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const original = thread('t1', { model: 'old-model' })
  const store = createStore({ activeProjectId: 'p1', threads: [original] })
  const autosave = attachAutosave(store, api)
  store.emit('threads_changed')
  await autosave.flush()
  calls.metas.length = 0
  const beforeChunk = { ...original, model: 'user-selected-model' }
  const afterChunk = {
    ...beforeChunk,
    usage: { inputTokens: 10, outputTokens: 20 },
    status: 'running' as const,
  }
  store.setState({ threads: [afterChunk] })
  acceptRuntimeThreadMeta('p1', afterChunk, transcriptMeta(beforeChunk))
  store.emit('usage_updated', 't1')
  await autosave.flush()
  assert.deepEqual(
    calls.metas.map((call) => call.patch),
    [{ model: 'user-selected-model' }],
  )
  autosave.detach()
})

test('a turn starts only after the thread writes queued before it', async () => {
  __resetPersistenceForTest()
  const order: string[] = []
  let releaseCreate: () => void = () => undefined
  const { api } = fakeApi({
    create: () =>
      new Promise<void>((resolve) => {
        releaseCreate = (): void => {
          order.push('create')
          resolve()
        }
      }),
  })
  const store = createStore({
    activeProjectId: 'p1',
    activeThreadId: 't1',
    threads: [],
    projects: [],
  })
  const autosave = attachAutosave(store, api)
  store.setState({ threads: [thread('t1')] })
  store.emit('threads_changed')

  const started = afterThreadWrites('p1', 't1', async () => {
    order.push('run')
  })
  await tick()
  assert.deepEqual(order, [], 'the run waits for the queued create')
  releaseCreate()
  await started
  assert.deepEqual(order, ['create', 'run'])

  // Nothing queued: the run starts synchronously, as before.
  let ranSync = false
  void afterThreadWrites('p1', 't2', async () => {
    ranSync = true
  })
  assert.equal(ranSync, true)
  autosave.detach()
})

test('a failed thread create is retried by an unchanged flush', async () => {
  __resetPersistenceForTest()
  const created: Thread[] = []
  const { api, calls } = fakeApi({
    create: async (_projectId, value) => {
      created.push(value)
      if (created.length === 1) throw new Error('disk full')
    },
  })
  const value = thread('retry-create', { draftPrompt: 'keep my draft' })
  await assert.rejects(flushProjectThreads(api, 'p1', [value]), /disk full/)
  await flushProjectThreads(api, 'p1', [value])
  await flushProjectThreads(api, 'p1', [value])
  assert.equal(created.length, 2, 'retry creates the missing thread, then deduplicates')
  assert.equal(created[1]?.draftPrompt, 'keep my draft')
  assert.deepEqual(calls.metas, [], 'updateMeta cannot create a missing thread')
})

test('failed metadata patches retain edits and deletions for the next unchanged flush', async () => {
  __resetPersistenceForTest()
  const original = thread('retry-meta', { queuePaused: true })
  await seedPersistedThread('p1', original)
  const patches: unknown[] = []
  const { api } = fakeApi({
    updateMeta: async (_projectId, _threadId, patch) => {
      patches.push(patch)
      if (patches.length === 1) throw new Error('disk full')
    },
  })
  const next = thread('retry-meta', { draftPrompt: 'saved after retry' })
  await assert.rejects(flushProjectThreads(api, 'p1', [next]), /disk full/)
  await flushProjectThreads(api, 'p1', [next])
  await flushProjectThreads(api, 'p1', [next])
  assert.deepEqual(patches, [
    { draftPrompt: 'saved after retry', queuePaused: undefined },
    { draftPrompt: 'saved after retry', queuePaused: undefined },
  ])
})

test('failed deletion retries without rewriting a successfully saved sibling', async () => {
  __resetPersistenceForTest()
  await seedPersistedThread('p1', thread('remove'))
  await seedPersistedThread('p1', thread('keep'))
  let deletions = 0
  const { api, calls } = fakeApi({
    delete: async () => {
      deletions += 1
      if (deletions === 1) throw new Error('disk full')
    },
  })
  const retained = thread('keep', { title: 'new title' })
  await assert.rejects(flushProjectThreads(api, 'p1', [retained]), /disk full/)
  await flushProjectThreads(api, 'p1', [retained])
  await flushProjectThreads(api, 'p1', [retained])
  assert.equal(deletions, 2)
  assert.deepEqual(
    calls.metas.map((call) => call.patch),
    [{ title: 'new title' }],
  )
})

test('a queued update retries create after the preceding create fails', async () => {
  __resetPersistenceForTest()
  const created: Thread[] = []
  let rejectCreate: (error: Error) => void = () => undefined
  const { api, calls } = fakeApi({
    create: (_projectId, value) => {
      created.push(value)
      if (created.length > 1) return Promise.resolve()
      return new Promise<void>((_resolve, reject) => {
        rejectCreate = reject
      })
    },
  })
  const initial = flushProjectThreads(api, 'p1', [thread('queued')])
  const rejected = assert.rejects(initial, /disk full/)
  const updated = thread('queued', { draftPrompt: 'newer draft' })
  const latest = flushProjectThreads(api, 'p1', [updated])
  assert.equal(created.length, 1, 'later save waits for the earlier operation')
  rejectCreate(new Error('disk full'))
  await rejected
  await latest
  await flushProjectThreads(api, 'p1', [updated])
  assert.deepEqual(
    created.map((value) => value.draftPrompt),
    [undefined, 'newer draft'],
  )
  assert.deepEqual(
    calls.metas.map((call) => call.patch),
    [{ draftPrompt: 'newer draft' }],
  )
})

for (const deletionFails of [false, true]) {
  test(`queued delete then recreate stays ordered when delete ${deletionFails ? 'fails' : 'succeeds'}`, async () => {
    __resetPersistenceForTest()
    await seedPersistedThread('p1', thread('restored'))
    const operations: string[] = []
    let settleDelete: () => void = () => undefined
    const { api } = fakeApi({
      delete: () => {
        operations.push('delete')
        return new Promise<void>((resolve, reject) => {
          settleDelete = (): void => {
            if (deletionFails) reject(new Error('disk full'))
            else resolve()
          }
        })
      },
      create: async () => {
        operations.push('create')
      },
      updateMeta: async (_projectId, _threadId, patch) => {
        operations.push('update')
        assert.deepEqual(patch, { title: 'restored title' })
      },
    })
    const removed = flushProjectThreads(api, 'p1', [])
    const deletion = deletionFails ? assert.rejects(removed, /disk full/) : removed
    const restored = thread('restored', { title: 'restored title' })
    const recreated = flushProjectThreads(api, 'p1', [restored])
    assert.deepEqual(operations, ['delete'])
    settleDelete()
    await deletion
    await recreated
    await flushProjectThreads(api, 'p1', [restored])
    assert.deepEqual(
      operations,
      deletionFails ? ['delete', 'create', 'update'] : ['delete', 'create'],
    )
  })
}

test('runtime acceptance during a failed user write does not acknowledge unsaved user fields', async () => {
  __resetPersistenceForTest()
  const original = thread('runtime-retry', { model: 'old-model' })
  await seedPersistedThread('p1', original)
  let rejectUpdate: (error: Error) => void = () => undefined
  const patches: unknown[] = []
  const { api } = fakeApi({
    updateMeta: (_projectId, _threadId, patch) => {
      patches.push(patch)
      if (patches.length > 1) return Promise.resolve()
      return new Promise<void>((_resolve, reject) => {
        rejectUpdate = reject
      })
    },
  })
  const edited = { ...original, model: 'user-model', draftPrompt: 'unsaved draft' }
  const first = flushProjectThreads(api, 'p1', [edited])
  const rejected = assert.rejects(first, /disk full/)
  const runtimeUpdated = {
    ...edited,
    status: 'running' as const,
    usage: { inputTokens: 10, outputTokens: 20 },
  }
  acceptRuntimeThreadMeta('p1', runtimeUpdated, transcriptMeta(edited))
  rejectUpdate(new Error('disk full'))
  await rejected
  await flushProjectThreads(api, 'p1', [runtimeUpdated])
  await flushProjectThreads(api, 'p1', [runtimeUpdated])
  assert.deepEqual(
    patches,
    [
      { model: 'user-model', draftPrompt: 'unsaved draft' },
      { model: 'user-model', draftPrompt: 'unsaved draft' },
    ],
    'retry writes user fields only; main already owns the runtime fields',
  )
})

for (const operation of ['create', 'update', 'delete'] as const) {
  test(`an unchanged flush awaits a pending ${operation} and observes its rejection`, async () => {
    __resetPersistenceForTest()
    const original = thread('pending')
    if (operation !== 'create') await seedPersistedThread('p1', original)
    let rejectWrite: (error: Error) => void = () => undefined
    const write = (): Promise<void> =>
      new Promise<void>((_resolve, reject) => {
        rejectWrite = reject
      })
    const { api } = fakeApi({
      create: write,
      updateMeta: write,
      delete: write,
    })
    const target = operation === 'delete' ? [] : [thread('pending', { title: 'new title' })]
    const first = flushProjectThreads(api, 'p1', target)
    const firstRejection = assert.rejects(first, /disk full/)
    let settled = false
    const duplicate = flushProjectThreads(api, 'p1', target)
    const duplicateRejection = assert.rejects(
      duplicate.finally(() => {
        settled = true
      }),
      /disk full/,
    )
    await tick()
    assert.equal(settled, false, 'unchanged does not mean acknowledged')
    rejectWrite(new Error('disk full'))
    await Promise.all([firstRejection, duplicateRejection])
  })
}

test('retry after a committed create preserves newer main messages and runtime metadata', async () => {
  __resetPersistenceForTest()
  const disk = new Map<string, Thread>()
  let creates = 0
  const { api } = fakeApi({
    create: async (_projectId, value) => {
      creates += 1
      // The production create endpoint is idempotent for an existing thread.
      if (!disk.has(value.id)) disk.set(value.id, structuredClone(value))
      if (creates === 1) {
        const stored = disk.get(value.id)
        assert.ok(stored)
        disk.set(value.id, {
          ...stored,
          messages: [...stored.messages, { ...userMsg('main-message'), role: 'assistant' }],
          status: 'running',
          usage: { inputTokens: 99, outputTokens: 50 },
        })
        throw new Error('catalog full after thread commit')
      }
    },
    updateMeta: async (_projectId, threadId, patch) => {
      assert.deepEqual(patch, { draftPrompt: 'latest draft', queuePaused: undefined })
      const stored = disk.get(threadId)
      assert.ok(stored)
      const next = { ...stored, draftPrompt: 'latest draft' }
      delete next.queuePaused
      disk.set(threadId, next)
    },
  })
  const initial = thread('partial-create', { messages: [userMsg('original')], queuePaused: true })
  await assert.rejects(flushProjectThreads(api, 'p1', [initial]), /catalog full/)
  const latest = thread('partial-create', {
    messages: initial.messages,
    draftPrompt: 'latest draft',
  })
  await flushProjectThreads(api, 'p1', [latest])
  await flushProjectThreads(api, 'p1', [latest])
  const stored = disk.get(initial.id)
  assert.ok(stored)
  assert.equal(creates, 2)
  assert.deepEqual(
    stored.messages.map((message) => message.id),
    ['original', 'main-message'],
  )
  assert.equal(stored.draftPrompt, 'latest draft')
  assert.equal(stored.queuePaused, undefined)
  assert.equal(stored.status, 'running')
  assert.deepEqual(stored.usage, { inputTokens: 99, outputTokens: 50 })
})

test('removing a thread after unacknowledged creation still deletes its possible committed copy', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi({
    create: async () => {
      throw new Error('catalog full after thread commit')
    },
  })
  await assert.rejects(flushProjectThreads(api, 'p1', [thread('unconfirmed')]), /catalog full/)
  await flushProjectThreads(api, 'p1', [])
  await flushProjectThreads(api, 'p1', [])
  assert.deepEqual(calls.deletes, [{ projectId: 'p1', threadId: 'unconfirmed' }])
})

function applyThreadMeta(value: Thread, patch: unknown): Thread {
  const next = parseThreadValue({ ...value, ...expectRecord(patch) })
  assert.ok(next)
  return next
}

for (const queued of [false, true]) {
  test(`repairs a partially committed metadata patch when ${queued ? 'queued' : 'later'} edits revert to the acknowledged value`, async () => {
    __resetPersistenceForTest()
    const original = thread('partial-update')
    await seedPersistedThread('p1', original)
    let disk = original
    let attempts = 0
    let rejectFirst: (error: Error) => void = () => undefined
    const { api } = fakeApi({
      updateMeta: (_projectId, _threadId, patch) => {
        attempts += 1
        disk = applyThreadMeta(disk, patch)
        if (attempts > 1) return Promise.resolve()
        return new Promise<void>((_resolve, reject) => {
          rejectFirst = reject
        })
      },
    })
    const failed = flushProjectThreads(api, 'p1', [{ ...original, title: 'temporary edit' }])
    const rejected = assert.rejects(failed, /catalog failed after commit/)
    const reverted = queued ? flushProjectThreads(api, 'p1', [original]) : undefined
    rejectFirst(new Error('catalog failed after commit'))
    await rejected
    if (reverted) await reverted
    else await flushProjectThreads(api, 'p1', [original])
    await flushProjectThreads(api, 'p1', [original])
    assert.equal(disk.title, original.title)
    assert.equal(attempts, 2)
  })
}

for (const paused of [false, true]) {
  test(`repairs a rejected optional-field ${paused ? 'removal' : 'addition'} when the user reverts it`, async () => {
    __resetPersistenceForTest()
    const original = thread('optional-update', paused ? { queuePaused: true } : {})
    const edited = thread('optional-update', paused ? {} : { queuePaused: true })
    await seedPersistedThread('p1', original)
    let disk = original
    let attempts = 0
    const { api } = fakeApi({
      updateMeta: async (_projectId, _threadId, patch) => {
        disk = applyThreadMeta(disk, patch)
        if (++attempts === 1) throw new Error('catalog failed after commit')
      },
    })
    await assert.rejects(flushProjectThreads(api, 'p1', [edited]), /catalog failed/)
    await flushProjectThreads(api, 'p1', [original])
    assert.equal(disk.queuePaused, original.queuePaused)
    assert.equal(attempts, 2)
  })
}

test('usage-only runtime acceptance preserves uncertain user model and draft retry intent', async () => {
  __resetPersistenceForTest()
  const original = thread('mixed-ownership', { model: 'old-model', draftPrompt: 'old draft' })
  await seedPersistedThread('p1', original)
  let disk = original
  const patches: unknown[] = []
  const { api } = fakeApi({
    updateMeta: async (_projectId, _threadId, patch) => {
      patches.push(patch)
      disk = applyThreadMeta(disk, patch)
      if (patches.length === 1) throw new Error('catalog failed after commit')
    },
  })
  await assert.rejects(
    flushProjectThreads(api, 'p1', [{ ...original, model: 'new-model', draftPrompt: 'new draft' }]),
    /catalog failed/,
  )
  // The user undoes both edits; the runtime then reports usage without
  // acknowledging the model/draft fields. Their uncertain patch keys survive.
  const runtime = { ...original, usage: { inputTokens: 77, outputTokens: 33 } }
  disk = { ...disk, usage: runtime.usage }
  acceptRuntimeThreadMeta('p1', runtime, transcriptMeta(original))
  await flushProjectThreads(api, 'p1', [runtime])
  assert.deepEqual(patches[1], { model: 'old-model', draftPrompt: 'old draft' })
  assert.equal(disk.model, 'old-model')
  assert.equal(disk.draftPrompt, 'old draft')
  assert.deepEqual(disk.usage, runtime.usage)
})

for (const removed of [false, true]) {
  for (const edited of [false, true]) {
    test(`re-establishes existence after delete rejects ${removed ? 'after' : 'before'} removal with ${edited ? 'new' : 'unchanged'} metadata`, async () => {
      __resetPersistenceForTest()
      const original = thread('partial-delete', { messages: [userMsg('original')] })
      await seedPersistedThread('p1', original)
      const disk = new Map([[original.id, original]])
      const newer = { ...userMsg('new-main-message'), role: 'assistant' as const }
      let creates = 0
      const { api } = fakeApi({
        delete: async () => {
          if (removed) disk.delete(original.id)
          else {
            disk.set(original.id, {
              ...original,
              messages: [...original.messages, newer],
              usage: { inputTokens: 99, outputTokens: 11 },
            })
          }
          throw new Error('delete acknowledgement failed')
        },
        create: async (_projectId, value) => {
          creates += 1
          if (!disk.has(value.id)) disk.set(value.id, structuredClone(value))
        },
        updateMeta: async (_projectId, id, patch) => {
          const current = disk.get(id)
          assert.ok(current, 'existence is re-established before metadata is patched')
          disk.set(id, applyThreadMeta(current, patch))
        },
      })
      await assert.rejects(flushProjectThreads(api, 'p1', []), /delete acknowledgement/)
      const target = edited ? { ...original, draftPrompt: 'restored draft' } : original
      await flushProjectThreads(api, 'p1', [target])
      await flushProjectThreads(api, 'p1', [target])
      const restored = disk.get(original.id)
      assert.ok(restored)
      assert.equal(creates, 1)
      assert.equal(restored.draftPrompt, target.draftPrompt)
      assert.deepEqual(
        restored.messages.map((message) => message.id),
        removed ? ['original'] : ['original', 'new-main-message'],
      )
      if (!removed) assert.deepEqual(restored.usage, { inputTokens: 99, outputTokens: 11 })
    })
  }
}

test('an unchanged deletion retries uncertain repair even after a load confirms its directory is absent', async () => {
  __resetPersistenceForTest()
  await seedPersistedThread('p1', thread('delete-retry'))
  let attempts = 0
  const { api } = fakeApi({
    delete: async () => {
      if (++attempts === 1) throw new Error('catalog failed after removal')
    },
  })
  await assert.rejects(flushProjectThreads(api, 'p1', []), /catalog failed/)
  await loadThreads(api, 'p1')
  await flushProjectThreads(api, 'p1', [])
  await flushProjectThreads(api, 'p1', [])
  assert.equal(attempts, 2, 'absence on load does not acknowledge the failed catalog repair')
})

for (const acknowledgeFirst of [false, true]) {
  test(`an old load cannot erase a newer write ${acknowledgeFirst ? 'acknowledged before' : 'still pending at'} its response`, async () => {
    __resetPersistenceForTest()
    const original = thread('load-write', { lastSettledAt: 1 })
    await seedPersistedThread('p1', original)
    let disk = original
    let releaseLoad: (value: Thread[]) => void = () => undefined
    let releaseWrite: () => void = () => undefined
    let updates = 0
    const { api } = fakeApi({
      updateMeta: (_projectId, _threadId, patch) => {
        disk = applyThreadMeta(disk, patch)
        if (++updates > 1) return Promise.resolve()
        return new Promise<void>((resolve) => {
          releaseWrite = resolve
        })
      },
    })
    api.threads.loadProject = (): Promise<Thread[]> =>
      new Promise<Thread[]>((resolve) => {
        releaseLoad = resolve
      })
    const loading = loadThreads(api, 'p1')
    const saving = flushProjectThreads(api, 'p1', [{ ...original, title: 'new title' }])
    if (acknowledgeFirst) {
      releaseWrite()
      await saving
    }
    releaseLoad([original])
    const loaded = await loading
    assert.equal(loaded[0]?.title, 'new title', 'the read does not replace newer local intent')
    const reverting = flushProjectThreads(api, 'p1', [original])
    if (!acknowledgeFirst) releaseWrite()
    await saving
    await reverting
    await flushProjectThreads(api, 'p1', [original])
    assert.equal(disk.title, original.title)
    assert.equal(updates, 2)
  })
}

for (const revert of [false, true]) {
  test(`an old load cannot acknowledge away a partial failed write before ${revert ? 'reverted' : 'unchanged'} retry`, async () => {
    __resetPersistenceForTest()
    const original = thread('load-failure', { lastSettledAt: 1 })
    await seedPersistedThread('p1', original)
    let disk = original
    let release: (value: Thread[]) => void = () => undefined
    let attempts = 0
    const { api } = fakeApi({
      updateMeta: async (_projectId, _threadId, patch) => {
        disk = applyThreadMeta(disk, patch)
        if (++attempts === 1) throw new Error('catalog failed after commit')
      },
    })
    api.threads.loadProject = (): Promise<Thread[]> =>
      new Promise<Thread[]>((resolve) => {
        release = resolve
      })
    const loading = loadThreads(api, 'p1')
    const edited = { ...original, title: 'new title' }
    await assert.rejects(flushProjectThreads(api, 'p1', [edited]), /catalog failed/)
    release([original])
    const loaded = await loading
    assert.equal(loaded[0]?.title, 'new title', 'failed write intent stays separate from seeding')
    const target = revert ? original : edited
    await flushProjectThreads(api, 'p1', [target])
    await flushProjectThreads(api, 'p1', [target])
    assert.equal(disk.title, target.title)
    assert.equal(attempts, 2)
  })
}

test('a stale load cannot resurrect an ID created and deleted during its request', async () => {
  __resetPersistenceForTest()
  const value = thread('load-aba', { lastSettledAt: 1 })
  let release: (value: Thread[]) => void = () => undefined
  const { api, calls } = fakeApi()
  api.threads.loadProject = (): Promise<Thread[]> =>
    new Promise<Thread[]>((resolve) => {
      release = resolve
    })
  const loading = loadThreads(api, 'p1')
  await flushProjectThreads(api, 'p1', [value])
  await flushProjectThreads(api, 'p1', [])
  release([value])
  const loaded = await loading
  assert.deepEqual(loaded, [])
  await flushProjectThreads(api, 'p1', loaded)
  assert.equal(calls.creates.length, 1)
  assert.equal(calls.deletes.length, 1)
})

test('seeding preserves changed IDs, discovers new IDs and drops unchanged IDs absent on disk', async () => {
  __resetPersistenceForTest()
  const original = thread('changed', { lastSettledAt: 1 })
  const missing = thread('missing', { lastSettledAt: 1 })
  const discovered = thread('discovered', { lastSettledAt: 1 })
  await seedPersistedThread('p1', original)
  await seedPersistedThread('p1', missing)
  let release: (value: Thread[]) => void = () => undefined
  const { api, calls } = fakeApi()
  api.threads.loadProject = (): Promise<Thread[]> =>
    new Promise<Thread[]>((resolve) => {
      release = resolve
    })
  const loading = loadThreads(api, 'p1')
  const latest = { ...original, title: 'new title' }
  await flushProjectThreads(api, 'p1', [latest, missing])
  release([original, discovered])
  const loaded = await loading
  assert.deepEqual(new Set(loaded.map((value) => value.id)), new Set(['changed', 'discovered']))
  assert.equal(loaded.find((value) => value.id === 'changed')?.title, 'new title')
  await flushProjectThreads(api, 'p1', loaded)
  assert.equal(calls.metas.length, 1)
  assert.equal(calls.creates.length, 0, 'newly discovered metadata is already persisted')
  assert.equal(calls.deletes.length, 0, 'authoritative absence is already acknowledged')
})

for (const newerFirst of [false, true]) {
  test(`concurrent loads retain the newer response when it resolves ${newerFirst ? 'first' : 'last'}`, async () => {
    __resetPersistenceForTest()
    const original = thread('read-order', { title: 'old title', lastSettledAt: 1 })
    const newer = { ...original, title: 'new title' }
    await seedPersistedThread('p1', original)
    const releases: Array<(value: Thread[]) => void> = []
    const { api, calls } = fakeApi()
    api.threads.loadProject = (): Promise<Thread[]> =>
      new Promise<Thread[]>((resolve) => {
        releases.push(resolve)
      })
    const first = loadThreads(api, 'p1')
    const second = loadThreads(api, 'p1')
    const releaseFirst = releases[0]
    const releaseSecond = releases[1]
    assert.ok(releaseFirst)
    assert.ok(releaseSecond)
    if (newerFirst) {
      releaseSecond([newer])
      await second
      releaseFirst([original])
      await first
    } else {
      releaseFirst([original])
      await first
      releaseSecond([newer])
      await second
    }
    await flushProjectThreads(api, 'p1', [newer])
    assert.deepEqual(calls.metas, [], 'the newest read already seeded the new title')
  })
}

test('a newer empty full load protects absence against previously undiscovered stale IDs', async () => {
  __resetPersistenceForTest()
  const value = thread('unknown-to-newer-read', { lastSettledAt: 1 })
  const releases: Array<(value: Thread[]) => void> = []
  const { api, calls } = fakeApi()
  api.threads.loadProject = (): Promise<Thread[]> =>
    new Promise<Thread[]>((resolve) => {
      releases.push(resolve)
    })
  const first = loadThreads(api, 'p1')
  const second = loadThreads(api, 'p1')
  const releaseFirst = releases[0]
  const releaseSecond = releases[1]
  assert.ok(releaseFirst)
  assert.ok(releaseSecond)
  releaseSecond([])
  await second
  releaseFirst([value])
  assert.deepEqual(await first, [])
  await flushProjectThreads(api, 'p1', [])
  assert.deepEqual(calls.deletes, [])
})

test('a newer one-thread load protects its absent thread without replacing other project metadata', async () => {
  __resetPersistenceForTest()
  const missing = thread('missing-one', { lastSettledAt: 1 })
  const untouched = thread('untouched', { lastSettledAt: 1 })
  await seedPersistedThread('p1', missing)
  await seedPersistedThread('p1', untouched)
  const releases: Array<(value: Thread[]) => void> = []
  const { api, calls } = fakeApi()
  api.threads.loadProject = (): Promise<Thread[]> =>
    new Promise<Thread[]>((resolve) => {
      releases.push(resolve)
    })
  const project = loadThreads(api, 'p1')
  const single = loadPersistedThread(api, 'p1', missing.id)
  const releaseProject = releases[0]
  const releaseSingle = releases[1]
  assert.ok(releaseProject)
  assert.ok(releaseSingle)
  releaseSingle([untouched])
  assert.equal(await single, undefined)
  releaseProject([missing, untouched])
  assert.deepEqual(
    (await project).map((value) => value.id),
    ['untouched'],
  )
  await flushProjectThreads(api, 'p1', [untouched])
  assert.deepEqual(calls.deletes, [])
})

test('a primary-data load does not falsely acknowledge a failed create catalog repair', async () => {
  __resetPersistenceForTest()
  const initial = thread('create-read', { model: 'initial-model', lastSettledAt: 1 })
  let disk = initial
  let creates = 0
  const { api, calls } = fakeApi({
    create: async () => {
      if (++creates === 1) {
        disk = { ...initial, model: 'runtime-model', usage: { inputTokens: 88, outputTokens: 22 } }
        throw new Error('catalog failed after create')
      }
    },
  })
  api.threads.loadProject = async (): Promise<Thread[]> => [disk]
  await assert.rejects(flushProjectThreads(api, 'p1', [initial]), /catalog failed/)
  const loaded = await loadThreads(api, 'p1')
  assert.equal(loaded[0]?.model, 'runtime-model')
  await flushProjectThreads(api, 'p1', loaded)
  await flushProjectThreads(api, 'p1', loaded)
  assert.equal(creates, 2, 'create still repairs its failed catalog after a metadata-only read')
  assert.deepEqual(
    calls.metas,
    [],
    'observed main-owned fields are not mistaken for later user edits',
  )
  assert.equal(disk.model, 'runtime-model')
  assert.deepEqual(disk.usage, { inputTokens: 88, outputTokens: 22 })
})

test('an invalidated read retries with a newer request generation', async () => {
  __resetPersistenceForTest()
  const original = thread('reloaded', { title: 'old', lastSettledAt: 1 })
  const middle = { ...original, title: 'middle' }
  const latest = { ...original, title: 'latest' }
  await seedPersistedThread('p1', original)
  const releases: Array<(value: Thread[]) => void> = []
  const { api, calls } = fakeApi()
  api.threads.loadProject = (): Promise<Thread[]> =>
    new Promise<Thread[]>((resolve) => {
      releases.push(resolve)
    })
  const first = loadThreads(api, 'p1')
  const second = loadThreads(api, 'p1')
  const releaseFirst = releases[0]
  const releaseSecond = releases[1]
  assert.ok(releaseFirst)
  assert.ok(releaseSecond)
  releaseSecond([middle])
  await second
  invalidateProjectThreadLoads(api, 'p1')
  releaseFirst([original])
  await tick()
  const releaseRetry = releases[2]
  assert.ok(releaseRetry)
  releaseRetry([latest])
  assert.equal((await first)[0]?.title, 'latest')
  await flushProjectThreads(api, 'p1', [latest])
  assert.deepEqual(calls.metas, [])
})

test('newer saved-plan retention survives an older read, hydration and real blank-thread pruning', async (t) => {
  __resetPersistenceForTest()
  const original = thread('saved-plan', { lastSettledAt: 1, messagesLoaded: false })
  const releases: Array<(value: Thread[]) => void> = []
  const { api, calls } = fakeApi()
  api.threads.loadProject = (): Promise<Thread[]> =>
    new Promise((resolve) => {
      releases.push(resolve)
    })
  const older = loadThreads(api, 'p1')
  const newer = loadThreads(api, 'p1')
  const releaseOlder = releases[0]
  const releaseNewer = releases[1]
  assert.ok(releaseOlder)
  assert.ok(releaseNewer)
  releaseNewer([{ ...original, hasSavedPlan: true }])
  assert.equal((await newer)[0]?.hasSavedPlan, true)
  releaseOlder([original])
  const rows = await older
  assert.equal(rows[0]?.hasSavedPlan, true)
  const store = createStore({ activeProjectId: 'p1', activeThreadId: original.id, threads: rows })
  const autosave = attachAutosave(store, api)
  const detachHydration = attachThreadHydration(store, api)
  t.after(() => {
    autosave.detach()
    detachHydration()
  })
  await ensureThreadMessages('p1', original.id)
  const hydrated = store.getState().threads.find((value) => value.id === original.id)
  assert.ok(hydrated)
  assert.equal(hydrated.messagesLoaded, true)
  assert.equal(isBlankThread(hydrated), false)
  createThread(store)
  normalizeBlankThreads(store)
  await autosave.flush()
  assert.ok(store.getState().threads.some((value) => value.id === original.id))
  assert.deepEqual(calls.deletes, [], 'autosave must never delete the plan-only task')
  assert.ok(
    calls.metas.every((call) => !Object.hasOwn(expectRecord(call.patch), 'hasSavedPlan')),
    'derived retention is never persisted as mutable metadata',
  )
})

test('a middle read cannot replace a newer retention projection in an older active read', async () => {
  __resetPersistenceForTest()
  const original = thread('projection-order', { lastSettledAt: 1, messagesLoaded: false })
  const releases: Array<(value: Thread[]) => void> = []
  const { api } = fakeApi()
  api.threads.loadProject = (): Promise<Thread[]> =>
    new Promise((resolve) => {
      releases.push(resolve)
    })
  const oldest = loadThreads(api, 'p1')
  const middle = loadThreads(api, 'p1')
  const newest = loadThreads(api, 'p1')
  const first = releases[0]
  const second = releases[1]
  const third = releases[2]
  assert.ok(first)
  assert.ok(second)
  assert.ok(third)
  third([{ ...original, hasSavedPlan: true }])
  await newest
  second([{ ...original, hasSavedPlan: false }])
  assert.equal((await middle)[0]?.hasSavedPlan, true)
  first([original])
  assert.equal((await oldest)[0]?.hasSavedPlan, true)
})
