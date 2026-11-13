import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureThreadStore } from '@copse/thread-store/environment.ts'
import { createStore } from '@shared/store/store.ts'
import type { AutomationTriggerEvent, Thread } from '@shared/types'
import type { PreparedThreadCheckout } from '@shared/types/worktree.ts'
import {
  attachAutomationController,
  AUTOMATION_START_RETRY_MS,
  type AutomationControllerApi,
} from './automations.ts'
import { isRecord } from '@shared/unknown-value.ts'
import {
  addMessage,
  getThreadById,
  setThreadDraftPrompt,
  setThreadStatus,
} from '@shared/store/thread-helpers.ts'
import { startHumanTurnTree } from './message-queue.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { attachThreadHydration } from './thread-hydration.ts'
import { adoptBackgroundThreads, carryRunningThreads } from './background-threads.ts'
import {
  getSidebarThreads,
  resetProjectSwitchStateForTest,
  setThreadCacheForTest,
  switchProjectAndWait,
} from './projects.ts'
import { withoutMainOwnedThreadFields } from '../../main/ipc/thread-meta-guard.ts'
import {
  appendMessage,
  closeThreadStoreIndexes,
  createThread as createStoredThread,
  getThreadMeta,
  loadProjectThreadMetas,
  loadThreadMessages,
  updateMeta,
} from '../../main/services/thread-store.ts'
import {
  __resetPersistenceForTest,
  attachAutosave,
  AUTOSAVE_DEBOUNCE_MS,
  flushProjectThreads,
  invalidateProjectThreadLoads,
  loadThreads,
  projectThreadLoadRevision,
} from './persistence.ts'

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function automationThread(id = 'scheduled-thread'): Thread {
  return {
    id,
    title: 'CI review',
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    model: 'mock-model',
    draftPrompt: 'Review CI and report any failures.',
    automation: {
      scheduleId: 'schedule-ci',
      scheduleName: 'CI review',
      triggeredAt: 100,
    },
    createdAt: 100,
    updatedAt: 100,
  }
}

function controllerApi(loaded: Thread[]): {
  api: AutomationControllerApi
  emitTrigger: (event: AutomationTriggerEvent) => void
  prepared: Array<{
    projectId: string
    threadId: string
    prompt: string
    choice: string
    model: string | undefined
  }>
  runs: Array<{ projectId: string; threadId: string; payload: string }>
} {
  let triggerHandler: ((event: AutomationTriggerEvent) => void) | null = null
  const prepared: Array<{
    projectId: string
    threadId: string
    prompt: string
    choice: string
    model: string | undefined
  }> = []
  const runs: Array<{ projectId: string; threadId: string; payload: string }> = []
  const checkout: PreparedThreadCheckout = {
    checkoutMode: 'shared',
    choice: 'automatic',
    branch: 'develop',
  }
  const api: AutomationControllerApi = {
    agent: {
      prepareCheckout(projectId, threadId, prompt, choice, model) {
        prepared.push({ projectId, threadId, prompt, choice, model })
        return Promise.resolve(checkout)
      },
      run(projectId, threadId, payload) {
        runs.push({ projectId, threadId, payload })
        return Promise.resolve()
      },
    },
    automations: {
      list: () => Promise.resolve([]),
      listBranchCi: () => Promise.resolve([]),
      canStart: () => Promise.resolve({ allowed: true }),
      reportStartFailure: () => Promise.resolve(true),
      onTriggered(handler) {
        triggerHandler = handler
        return () => {
          triggerHandler = null
        }
      },
    },
    threads: {
      loadMessages: () => Promise.resolve([]),
      loadProject: () => Promise.resolve(loaded),
    },
  }
  return {
    api,
    emitTrigger(event): void {
      triggerHandler?.(event)
    },
    prepared,
    runs,
  }
}

for (const entry of ['startup', 'navigation']) {
  for (const projection of ['loaded', 'metadata']) {
    test(`a completed automation draft stays manual on ${entry} with ${projection} history`, async () => {
      const prompt: Thread['messages'][number] = {
        id: 'submitted-scheduled-prompt',
        role: 'user',
        content: 'Review CI.',
        toolCalls: [],
        createdAt: 100,
      }
      const completed: Thread = {
        ...automationThread(),
        draftPrompt: 'Ask about the next release when I return.',
        ...(projection === 'metadata'
          ? { messages: [], messagesLoaded: false, lastPromptAt: 100 }
          : { messages: [prompt], messagesLoaded: true }),
      }
      const store = createStore({
        activeProjectId: entry === 'startup' ? 'project-a' : 'project-b',
        workspaceRoot: entry === 'startup' ? '/repo/a' : '/repo/b',
        threads: entry === 'startup' ? [completed] : [],
      })
      const harness = controllerApi([completed])
      const dispose = attachAutomationController(store, harness.api)
      try {
        if (entry === 'navigation') {
          store.setState({
            activeProjectId: 'project-a',
            workspaceRoot: '/repo/a',
            threads: [completed],
          })
        }
        await tick()
        await tick()
        assert.deepEqual(harness.prepared, [])
        assert.deepEqual(harness.runs, [])
        assert.strictEqual(store.getState().threads[0], completed)
        assert.equal(store.getState().threads[0]?.currentEpoch, undefined)
      } finally {
        dispose()
      }
    })
  }
}

for (const completed of [true, false]) {
  test(`actual hydration ${completed ? 'keeps a legacy completed draft manual before checkout' : 'preserves a fresh scheduled first start'}`, async () => {
    const pending: Thread = {
      ...automationThread(),
      messagesLoaded: false,
      draftPrompt: completed ? 'Keep this follow-up manual.' : 'Review CI and report any failures.',
    }
    const store = createStore({
      activeProjectId: 'project-b',
      workspaceRoot: '/repo/b',
      threads: [],
    })
    const base = createFakeApi()
    let prepared = 0
    let runs = 0
    const api = {
      ...base,
      threads: {
        ...base.threads,
        loadMessages: (): Promise<Thread['messages']> =>
          Promise.resolve(
            completed
              ? [
                  {
                    id: 'prior-user',
                    role: 'user',
                    content: 'Review CI.',
                    toolCalls: [],
                    createdAt: 100,
                  },
                  {
                    id: 'prior-answer',
                    role: 'assistant',
                    content: 'Finished.',
                    toolCalls: [],
                    createdAt: 200,
                  },
                ]
              : [],
          ),
      },
      agent: {
        ...base.agent,
        prepareCheckout: (): ReturnType<typeof base.agent.prepareCheckout> => {
          prepared++
          return Promise.resolve({ checkoutMode: 'shared', choice: 'automatic', branch: 'main' })
        },
        run: (): Promise<void> => {
          runs++
          return Promise.resolve()
        },
      },
      automations: {
        ...base.automations,
        list: (): ReturnType<typeof base.automations.list> => Promise.resolve([]),
        listBranchCi: (): ReturnType<typeof base.automations.listBranchCi> => Promise.resolve([]),
        canStart: (): ReturnType<typeof base.automations.canStart> =>
          Promise.resolve({ allowed: true }),
      },
    }
    const detachHydration = attachThreadHydration(store, api)
    const detachAutomation = attachAutomationController(store, api)
    try {
      store.setState({
        activeProjectId: 'project-a',
        workspaceRoot: '/repo/a',
        activeThreadId: pending.id,
        threads: [pending],
      })
      await tick()
      await tick()
      const current = store.getState().threads[0]
      assert.equal(prepared, completed ? 0 : 1)
      assert.equal(runs, completed ? 0 : 1)
      if (completed) {
        assert.equal(current?.lastPromptAt, 100)
        assert.equal(current.draftPrompt, pending.draftPrompt)
        assert.equal(current.worktreeChoice, undefined)
      }
    } finally {
      detachAutomation()
      detachHydration()
    }
  })
}

function carriedCompletionFixture(): {
  carried: Thread
  settled: Thread
  messages: Thread['messages']
  other: Thread
  store: ReturnType<typeof createStore>
  api: ReturnType<typeof createFakeApi>
  trigger: (patch?: Partial<AutomationTriggerEvent>, headlessSettled?: boolean) => void
  runs: ReturnType<typeof controllerApi>['runs']
  prepared: ReturnType<typeof controllerApi>['prepared']
} {
  resetProjectSwitchStateForTest()
  const prompt: Thread['messages'][number] = {
    id: 'headless-prompt',
    role: 'user',
    content: 'Review CI.',
    toolCalls: [],
    createdAt: 100,
  }
  const partial: Thread['messages'][number] = {
    id: 'headless-answer',
    role: 'assistant',
    content: 'Checking',
    toolCalls: [
      { id: 'headless-tool', name: 'read_file', args: {}, status: 'running', result: null },
    ],
    createdAt: 101,
  }
  const carried: Thread = {
    ...automationThread('carried-headless'),
    status: 'running',
    draftPrompt: 'A follow-up draft',
    pendingMessages: [
      { messageId: 'queued-human', payload: { content: 'A queued follow-up' }, createdAt: 150 },
    ],
    queuePaused: true,
    messages: [prompt, partial],
    messagesLoaded: true,
  }
  const messages: Thread['messages'] = [
    prompt,
    {
      ...partial,
      content: 'The check finished.',
      toolCalls: [
        {
          id: 'headless-tool',
          name: 'read_file',
          args: {},
          status: 'done',
          result: 'The actual completed payload.',
        },
      ],
    },
  ]
  const settled: Thread = {
    ...automationThread(carried.id),
    status: 'idle',
    draftPrompt: '',
    messages: [],
    updatedAt: 200,
  }
  const other: Thread = {
    id: 'other-project-thread',
    title: 'Current project work',
    status: 'idle',
    draftPrompt: 'Keep this other draft.',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
  const store = createStore({
    projects: [
      { id: 'project-a', path: '/repo/a', name: 'A' },
      { id: 'project-b', path: '/repo/b', name: 'B' },
      { id: 'project-c', path: '/repo/c', name: 'C' },
    ],
    activeProjectId: 'project-b',
    activeThreadId: other.id,
    threads: [other],
    backgroundThreads: [{ projectId: 'project-a', thread: carried }],
  })
  setThreadCacheForTest('project-a', [carried])
  const harness = controllerApi([settled])
  const base = createFakeApi()
  const api: ReturnType<typeof createFakeApi> = {
    ...base,
    agent: { ...base.agent, ...harness.api.agent },
    automations: { ...base.automations, ...harness.api.automations },
    threads: {
      ...base.threads,
      ...harness.api.threads,
      loadMessages: () => Promise.resolve(messages),
    },
  }
  return {
    carried,
    settled,
    messages,
    other,
    store,
    api,
    trigger(patch, headlessSettled = true): void {
      harness.emitTrigger({
        projectId: 'project-a',
        threadId: carried.id,
        scheduleId: 'schedule-ci',
        triggeredAt: 100,
        disposition: 'started',
        ...(headlessSettled ? { headlessSettled: true } : {}),
        ...patch,
      })
    },
    runs: harness.runs,
    prepared: harness.prepared,
  }
}

function holdCompletionRead(
  fixture: ReturnType<typeof carriedCompletionFixture>,
  phase: 'metadata' | 'messages',
): { started: Promise<void>; release: () => void } {
  let entered = (): void => {}
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release = (): void => {}
  let first = true
  if (phase === 'metadata') {
    fixture.api.threads.loadProject = (): Promise<Thread[]> => {
      if (!first) return Promise.resolve([fixture.settled])
      first = false
      entered()
      return new Promise((resolve) => {
        release = (): void => {
          resolve([fixture.settled])
        }
      })
    }
  } else {
    fixture.api.threads.loadMessages = (): Promise<Thread['messages']> => {
      if (!first) return Promise.resolve(fixture.messages)
      first = false
      entered()
      return new Promise((resolve) => {
        release = (): void => {
          resolve(fixture.messages)
        }
      })
    }
  }
  return {
    started,
    release: (): void => {
      release()
    },
  }
}

test('an inactive carried completion takes authoritative terminal history and keeps human drafts and queue', async () => {
  const fixture = carriedCompletionFixture()
  const active = fixture.store.getState().threads
  const dispose = attachAutomationController(fixture.store, fixture.api)
  try {
    fixture.trigger()
    await tick()
    await tick()
    const updated = fixture.store.getState().backgroundThreads[0]?.thread
    assert.equal(updated?.status, 'idle')
    assert.deepEqual(updated.messages, fixture.messages)
    assert.equal(updated.messagesLoaded, true)
    assert.equal(updated.draftPrompt, fixture.carried.draftPrompt)
    assert.deepEqual(updated.pendingMessages, fixture.carried.pendingMessages)
    assert.equal(updated.queuePaused, true)
    assert.strictEqual(fixture.store.getState().threads, active)
    assert.equal(fixture.store.getState().activeProjectId, 'project-b')
    assert.equal(fixture.store.getState().activeThreadId, fixture.other.id)
    assert.deepEqual(fixture.runs, [])
    assert.deepEqual(fixture.prepared, [])
  } finally {
    dispose()
  }
})

test('carried completion ownership includes project when another project has the same thread id', async () => {
  const fixture = carriedCompletionFixture()
  const collision: Thread = { ...fixture.other, id: fixture.carried.id }
  fixture.store.setState({ threads: [collision], activeThreadId: collision.id })
  const active = fixture.store.getState().threads
  const completed: string[] = []
  const stopStatus = fixture.store.on('thread_status_changed', (id): void => {
    completed.push(id)
  })
  const dispose = attachAutomationController(fixture.store, fixture.api)
  try {
    fixture.trigger()
    await tick()
    await tick()
    assert.equal(fixture.store.getState().backgroundThreads[0]?.thread.status, 'idle')
    assert.strictEqual(fixture.store.getState().threads, active)
    assert.strictEqual(fixture.store.getState().threads[0], collision)
    assert.deepEqual(completed, [])
  } finally {
    stopStatus()
    dispose()
  }
})

test('a carried completion refreshes only its cached sidebar owner', async () => {
  const fixture = carriedCompletionFixture()
  const sibling: Thread = { ...fixture.carried, id: 'another-run', title: 'Another run' }
  const foreign: Thread = { ...fixture.carried, title: 'Same id in a different project' }
  setThreadCacheForTest('project-a', [fixture.carried, sibling])
  setThreadCacheForTest('project-c', [foreign])
  const active = fixture.store.getState().threads
  const dispose = attachAutomationController(fixture.store, fixture.api)
  try {
    fixture.trigger()
    await tick()
    await tick()
    const owner = getSidebarThreads(fixture.store, 'project-a')[0]
    assert.equal(owner?.status, 'idle')
    assert.equal(owner.automationPendingStart, false)
    assert.equal(owner.messages, undefined)
    assert.strictEqual(getSidebarThreads(fixture.store, 'project-a')[1], sibling)
    assert.strictEqual(getSidebarThreads(fixture.store, 'project-c')[0], foreign)
    assert.strictEqual(fixture.store.getState().threads, active)
    assert.deepEqual(fixture.runs, [])
    assert.deepEqual(fixture.prepared, [])
  } finally {
    dispose()
  }
})

for (const patch of [
  { projectId: 'project-c' },
  { scheduleId: 'another-schedule' },
  { triggeredAt: 99 },
]) {
  test(`ignores a nonmatching carried completion ${JSON.stringify(patch)}`, async () => {
    const fixture = carriedCompletionFixture()
    const dispose = attachAutomationController(fixture.store, fixture.api)
    try {
      fixture.trigger(patch)
      await tick()
      assert.strictEqual(fixture.store.getState().backgroundThreads[0]?.thread, fixture.carried)
      assert.strictEqual(getSidebarThreads(fixture.store, 'project-a')[0], fixture.carried)
      assert.deepEqual(fixture.runs, [])
      assert.deepEqual(fixture.prepared, [])
    } finally {
      dispose()
    }
  })
}

test('an ordinary trigger does not start or replace an inactive carried run', async () => {
  const fixture = carriedCompletionFixture()
  const dispose = attachAutomationController(fixture.store, fixture.api)
  try {
    fixture.trigger({}, false)
    await tick()
    assert.strictEqual(fixture.store.getState().backgroundThreads[0]?.thread, fixture.carried)
    assert.deepEqual(fixture.runs, [])
    assert.deepEqual(fixture.prepared, [])
  } finally {
    dispose()
  }
})

test('a carried headless completion cannot replace an already newer human epoch', async () => {
  const fixture = carriedCompletionFixture()
  const newer: Thread = { ...fixture.carried, currentEpoch: 'new-human-tree' }
  fixture.store.setState({ backgroundThreads: [{ projectId: 'project-a', thread: newer }] })
  const dispose = attachAutomationController(fixture.store, fixture.api)
  try {
    fixture.trigger()
    await tick()
    assert.strictEqual(fixture.store.getState().backgroundThreads[0]?.thread, newer)
    assert.deepEqual(fixture.runs, [])
  } finally {
    dispose()
  }
})

for (const phase of ['metadata', 'messages'] as const) {
  for (const change of [
    'epoch',
    'human-message',
    'occurrence',
    'schedule',
    'thread-deleted',
    'project-deleted',
  ] as const) {
    test(`a carried completion keeps ${change} authoritative during its ${phase} read`, async () => {
      const fixture = carriedCompletionFixture()
      const held = holdCompletionRead(fixture, phase)
      const dispose = attachAutomationController(fixture.store, fixture.api)
      try {
        fixture.trigger()
        await held.started
        let next = fixture.carried
        if (change === 'epoch') next = { ...next, currentEpoch: 'new-human-tree' }
        if (change === 'human-message') {
          next = {
            ...next,
            messages: [
              ...next.messages,
              {
                id: 'new-human-message',
                role: 'user',
                content: 'Newer work',
                toolCalls: [],
                createdAt: 300,
              },
            ],
          }
        }
        if (change === 'occurrence' || change === 'schedule') {
          assert.ok(next.automation)
          next = {
            ...next,
            automation: {
              ...next.automation,
              ...(change === 'occurrence' ? { triggeredAt: 200 } : { scheduleId: 'new-schedule' }),
            },
          }
        }
        fixture.store.setState({
          backgroundThreads:
            change === 'thread-deleted' ? [] : [{ projectId: 'project-a', thread: next }],
          ...(change === 'project-deleted'
            ? {
                projects: fixture.store
                  .getState()
                  .projects.filter((project) => project.id !== 'project-a'),
              }
            : {}),
        })
        const active = fixture.store.getState().threads
        const carried = fixture.store.getState().backgroundThreads
        held.release()
        await tick()
        assert.strictEqual(fixture.store.getState().backgroundThreads, carried)
        assert.strictEqual(getSidebarThreads(fixture.store, 'project-a')[0], fixture.carried)
        assert.strictEqual(fixture.store.getState().threads, active)
        assert.equal(fixture.store.getState().activeProjectId, 'project-b')
        assert.deepEqual(fixture.runs, [])
        assert.deepEqual(fixture.prepared, [])
      } finally {
        held.release()
        dispose()
      }
    })
  }
}

test('a completion whose authoritative metadata is still running cannot stop the carried turn', async () => {
  const fixture = carriedCompletionFixture()
  fixture.api.threads.loadProject = (): Promise<Thread[]> => Promise.resolve([fixture.carried])
  const dispose = attachAutomationController(fixture.store, fixture.api)
  try {
    fixture.trigger()
    await tick()
    assert.strictEqual(fixture.store.getState().backgroundThreads[0]?.thread, fixture.carried)
  } finally {
    dispose()
  }
})

for (const target of ['project-a', 'project-c']) {
  test(`a carried completion follows its owner while navigation selects ${target}`, async () => {
    const fixture = carriedCompletionFixture()
    const held = holdCompletionRead(fixture, 'messages')
    const dispose = attachAutomationController(fixture.store, fixture.api)
    try {
      fixture.trigger()
      await held.started
      const active =
        target === 'project-a'
          ? adoptBackgroundThreads(fixture.store, target, [fixture.settled])
          : [fixture.other]
      fixture.store.setState({
        activeProjectId: target,
        activeThreadId: target === 'project-a' ? fixture.carried.id : fixture.other.id,
        threads: active,
      })
      held.release()
      await tick()
      assert.equal(fixture.store.getState().activeProjectId, target)
      if (target === 'project-a') {
        assert.equal(fixture.store.getState().backgroundThreads.length, 0)
        assert.deepEqual(fixture.store.getState().threads[0]?.messages, fixture.messages)
        assert.equal(fixture.store.getState().threads[0]?.status, 'idle')
      } else {
        assert.strictEqual(fixture.store.getState().threads, active)
        assert.equal(fixture.store.getState().backgroundThreads[0]?.thread.status, 'idle')
        assert.deepEqual(
          fixture.store.getState().backgroundThreads[0]?.thread.messages,
          fixture.messages,
        )
      }
      assert.deepEqual(fixture.runs, [])
      assert.deepEqual(fixture.prepared, [])
    } finally {
      held.release()
      dispose()
    }
  })
}

test('a completion opened while active still refreshes its carried owner after leaving mid-read', async () => {
  const fixture = carriedCompletionFixture()
  const opened = adoptBackgroundThreads(fixture.store, 'project-a', [fixture.settled])
  fixture.store.setState({
    activeProjectId: 'project-a',
    activeThreadId: fixture.carried.id,
    threads: opened,
  })
  const held = holdCompletionRead(fixture, 'messages')
  const dispose = attachAutomationController(fixture.store, fixture.api)
  try {
    fixture.trigger()
    await held.started
    carryRunningThreads(fixture.store, 'project-a', opened)
    fixture.store.setState({
      activeProjectId: 'project-b',
      activeThreadId: fixture.other.id,
      threads: [fixture.other],
    })
    held.release()
    await tick()
    assert.equal(fixture.store.getState().backgroundThreads[0]?.thread.status, 'idle')
    assert.deepEqual(
      fixture.store.getState().backgroundThreads[0]?.thread.messages,
      fixture.messages,
    )
    assert.strictEqual(fixture.store.getState().threads[0], fixture.other)
  } finally {
    held.release()
    dispose()
  }
})

test('removing the active project fences completion before asynchronous navigation finishes', async () => {
  const fixture = carriedCompletionFixture()
  const opened = adoptBackgroundThreads(fixture.store, 'project-a', [fixture.settled])
  fixture.store.setState({
    activeProjectId: 'project-a',
    activeThreadId: fixture.carried.id,
    threads: opened,
  })
  const held = holdCompletionRead(fixture, 'messages')
  const dispose = attachAutomationController(fixture.store, fixture.api)
  try {
    fixture.trigger()
    await held.started
    fixture.store.setState({
      projects: fixture.store.getState().projects.filter((project) => project.id !== 'project-a'),
    })
    held.release()
    await tick()
    assert.strictEqual(fixture.store.getState().threads, opened)
    assert.equal(fixture.store.getState().threads[0]?.status, 'running')
  } finally {
    held.release()
    dispose()
  }
})

test('a carried completion retries revised main metadata while preserving the latest unsent work', async () => {
  const fixture = carriedCompletionFixture()
  const held = holdCompletionRead(fixture, 'messages')
  const dispose = attachAutomationController(fixture.store, fixture.api)
  try {
    fixture.trigger()
    await held.started
    const retired: Thread = {
      ...fixture.settled,
      worktree: {
        path: '/repo/a/finished',
        branch: 'copse/finished',
        baseBranch: 'main',
        baseCommit: 'a'.repeat(40),
        createdAt: 100,
        seededFromDirtyProject: false,
        retiredAt: 300,
      },
    }
    let revisedReads = 0
    fixture.api.threads.loadProject = (): Promise<Thread[]> => {
      revisedReads++
      return Promise.resolve([retired])
    }
    const edited: Thread = {
      ...fixture.carried,
      draftPrompt: 'Latest draft',
      pendingMessages: [],
      queuePaused: false,
    }
    fixture.store.setState({ backgroundThreads: [{ projectId: 'project-a', thread: edited }] })
    invalidateProjectThreadLoads(fixture.api, 'project-a')
    held.release()
    await tick()
    const updated = fixture.store.getState().backgroundThreads[0]?.thread
    assert.equal(revisedReads, 1)
    assert.equal(updated?.worktree?.retiredAt, 300)
    assert.deepEqual(updated.messages, fixture.messages)
    assert.equal(updated.draftPrompt, 'Latest draft')
    assert.deepEqual(updated.pendingMessages, [])
    assert.equal(updated.queuePaused, false)
    assert.deepEqual(fixture.runs, [])
    assert.deepEqual(fixture.prepared, [])
  } finally {
    held.release()
    dispose()
  }
})

test('repeated completion delivery cannot duplicate the authoritative history or dispatch a follow-up', async () => {
  const fixture = carriedCompletionFixture()
  const dispose = attachAutomationController(fixture.store, fixture.api)
  try {
    fixture.trigger()
    await tick()
    fixture.trigger()
    await tick()
    const updated = fixture.store.getState().backgroundThreads[0]?.thread
    assert.deepEqual(updated?.messages, fixture.messages)
    assert.deepEqual(updated.pendingMessages, fixture.carried.pendingMessages)
    assert.deepEqual(fixture.runs, [])
    assert.deepEqual(fixture.prepared, [])
  } finally {
    dispose()
  }
})

test('revisiting a completed carried automation never submits its preserved human draft', async () => {
  const fixture = carriedCompletionFixture()
  const dispose = attachAutomationController(fixture.store, fixture.api)
  try {
    fixture.trigger()
    await tick()
    assert.equal(fixture.store.getState().backgroundThreads[0]?.thread.status, 'idle')
    const adopted = adoptBackgroundThreads(fixture.store, 'project-a', [fixture.settled])
    fixture.store.setState({
      activeProjectId: 'project-a',
      activeThreadId: fixture.carried.id,
      threads: adopted,
    })
    await tick()
    await tick()
    assert.deepEqual(fixture.runs, [])
    assert.deepEqual(fixture.prepared, [])
    assert.equal(fixture.store.getState().threads[0]?.draftPrompt, fixture.carried.draftPrompt)
    assert.deepEqual(fixture.store.getState().threads[0]?.messages, fixture.messages)
  } finally {
    dispose()
  }
})

test('a cron trigger submits its prompt as a new root agent turn', async () => {
  const created = automationThread()
  const store = createStore({
    activeProjectId: 'project-a',
    workspaceRoot: '/repo',
    threads: [],
  })
  const harness = controllerApi([created])
  const detach = attachAutomationController(store, harness.api)

  harness.emitTrigger({
    projectId: 'project-a',
    scheduleId: 'schedule-ci',
    threadId: created.id,
    triggeredAt: 100,
    disposition: 'started',
  })
  await tick()
  await tick()

  assert.deepEqual(harness.prepared, [
    {
      projectId: 'project-a',
      threadId: created.id,
      prompt: 'Review CI and report any failures.',
      choice: 'worktree',
      model: 'mock-model',
    },
  ])
  assert.equal(harness.runs.length, 1)
  const run = harness.runs[0]
  assert.ok(run)
  const payload: unknown = JSON.parse(run.payload)
  assert.ok(isRecord(payload))
  assert.equal(payload['content'], 'Review CI and report any failures.')
  assert.equal(payload['model'], 'mock-model')
  assert.equal(payload['automationRun'], true)
  assert.equal(typeof payload['turnTreeId'], 'string')
  assert.equal(payload['continuationBudgetUsed'], 0)

  const thread = store.getState().threads.find((candidate) => candidate.id === created.id)
  assert.ok(thread)
  assert.equal(thread.status, 'running')
  assert.equal(thread.draftPrompt, undefined)
  assert.equal(thread.messages.length, 1)
  const message = thread.messages[0]
  assert.ok(message)
  assert.equal(message.role, 'user')
  assert.equal(message.content, 'Review CI and report any failures.')
  assert.equal(thread.worktreeChoice, 'automatic')
  assert.equal(thread.gitBranch, 'develop')

  detach()
})

test('a persisted trigger missed during startup begins when its project is loaded', async () => {
  const created = automationThread()
  const store = createStore({
    activeProjectId: 'project-a',
    workspaceRoot: '/repo',
    threads: [created],
  })
  const harness = controllerApi([])
  const detach = attachAutomationController(store, harness.api)

  await tick()

  assert.equal(harness.prepared.length, 1)
  assert.equal(harness.runs.length, 1)
  assert.equal(store.getState().threads[0]?.status, 'running')

  detach()
})

test('a retryable admission denial starts after verification recovers', async (context): Promise<void> => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const created = automationThread()
  const store = createStore({
    activeProjectId: 'project-a',
    workspaceRoot: '/repo',
    threads: [created],
  })
  const harness = controllerApi([])
  let admissionChecks = 0
  harness.api.automations.canStart = (): ReturnType<
    AutomationControllerApi['automations']['canStart']
  > => {
    admissionChecks += 1
    if (admissionChecks <= 2) {
      return Promise.resolve({
        allowed: false,
        retryable: true,
        reason: 'GitHub verification is unavailable.',
      })
    }
    return Promise.resolve({ allowed: true })
  }
  const detach = attachAutomationController(store, harness.api)
  // Let the initial admission probe settle before advancing the retry timer.
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(harness.runs.length, 0)
  assert.equal(store.getState().threads[0]?.draftPrompt, created.draftPrompt)
  assert.equal(
    store.getState().threads[0]?.messages[0]?.content,
    'GitHub verification is unavailable.',
  )
  context.mock.timers.tick(AUTOMATION_START_RETRY_MS)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(admissionChecks, 2)
  assert.equal(harness.runs.length, 0)
  context.mock.timers.tick(AUTOMATION_START_RETRY_MS)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(admissionChecks, 4)
  assert.equal(harness.runs.length, 1)
  assert.equal(store.getState().threads[0]?.draftPrompt, undefined)
  assert.equal(
    store.getState().threads[0]?.messages.filter((message) => message.role === 'error').length,
    1,
  )
  detach()
})

test('a checkout failure preserves the scheduled prompt as a draft', async (context) => {
  context.mock.method(console, 'error', () => {})
  const created = automationThread()
  const store = createStore({
    activeProjectId: 'project-a',
    workspaceRoot: '/repo',
    threads: [created],
  })
  let runs = 0
  const api: AutomationControllerApi = {
    agent: {
      prepareCheckout: () => Promise.reject(new Error('checkout unavailable')),
      run: () => {
        runs += 1
        return Promise.resolve()
      },
    },
    automations: {
      list: () => Promise.resolve([]),
      listBranchCi: () => Promise.resolve([]),
      onTriggered: () => () => {},
      canStart: () => Promise.resolve({ allowed: true }),
      reportStartFailure: () => Promise.resolve(true),
    },
    threads: {
      loadMessages: () => Promise.resolve([]),
      loadProject: () => Promise.resolve([]),
    },
  }
  const detach = attachAutomationController(store, api)

  await tick()

  const thread = store.getState().threads[0]
  assert.ok(thread)
  assert.equal(thread.status, 'idle')
  assert.equal(thread.draftPrompt, 'Review CI and report any failures.')
  assert.equal(runs, 0)

  // The draft survives, and the thread says why it did not run. Before this
  // the failure was console-only: an idle thread holding a draft, with no
  // bell, no toast and nothing on screen to distinguish it from a run that
  // never fired.
  assert.equal(thread.messages.length, 1)
  const note = thread.messages[0]
  assert.ok(note)
  assert.equal(note.role, 'error')
  assert.match(note.content, /could not start/)
  assert.match(note.content, /checkout unavailable/)
  assert.match(note.content, /kept as a draft/)
  // Marked as failed, so the schedule's next trigger is not held up behind it.
  assert.notEqual(thread.automation?.startFailedAt, undefined)
  // No user bubble — the prompt was never submitted.
  assert.equal(thread.messages.filter((message) => message.role === 'user').length, 0)

  detach()
})

test('the IPC wrapper is stripped from the failure note', async (context) => {
  context.mock.method(console, 'error', () => {})
  const store = createStore({
    activeProjectId: 'project-a',
    workspaceRoot: '/repo',
    threads: [automationThread()],
  })
  const api: AutomationControllerApi = {
    agent: {
      prepareCheckout: () =>
        Promise.reject(
          new Error(
            "Error invoking remote method 'agent:prepare-checkout': Error: " +
              'Isolated worktree is unavailable: submodules unsupported (/repo/.gitmodules, for project /repo)',
          ),
        ),
      run: () => Promise.resolve(),
    },
    automations: {
      list: () => Promise.resolve([]),
      listBranchCi: () => Promise.resolve([]),
      onTriggered: () => () => {},
      canStart: () => Promise.resolve({ allowed: true }),
      reportStartFailure: () => Promise.resolve(true),
    },
    threads: { loadProject: () => Promise.resolve([]), loadMessages: () => Promise.resolve([]) },
  }
  const detach = attachAutomationController(store, api)

  await tick()

  const note = store.getState().threads[0]?.messages[0]
  assert.ok(note)
  // The Electron prefix is noise in a transcript; the cause is not.
  assert.doesNotMatch(note.content, /invoking remote method/)
  assert.match(note.content, /submodules unsupported \(\/repo\/\.gitmodules, for project \/repo\)/)

  detach()
})

for (const failure of [
  { message: 'Cannot create linked worktree', code: 'worktree-failed' },
  { message: 'Git authentication failed', code: 'worktree-failed' },
  {
    message:
      'Authentication helper cannot start because its configured command is missing or not executable.',
    code: 'no-model',
  },
  { message: 'The selected coding agent is not enabled.', code: 'no-model' },
]) {
  test(`records the checkout cause through IPC: ${failure.message}`, async (context) => {
    context.mock.method(console, 'error', () => {})
    const store = createStore({
      activeProjectId: 'project-a',
      workspaceRoot: '/repo',
      threads: [automationThread()],
    })
    const reports: Array<{ projectId: string; threadId: string; code: string; message: string }> =
      []
    let dispatches = 0
    const api: AutomationControllerApi = {
      agent: {
        prepareCheckout: () =>
          Promise.reject(
            new Error(
              "Error invoking remote method 'agent:prepare-checkout': Error: " + failure.message,
            ),
          ),
        run: () => {
          dispatches += 1
          return Promise.resolve()
        },
      },
      automations: {
        list: () => Promise.resolve([]),
        listBranchCi: () => Promise.resolve([]),
        onTriggered: () => () => {},
        canStart: () => Promise.resolve({ allowed: true }),
        reportStartFailure: (projectId, threadId, failure) => {
          reports.push({ projectId, threadId, ...failure })
          return Promise.resolve(true)
        },
      },
      threads: { loadProject: () => Promise.resolve([]), loadMessages: () => Promise.resolve([]) },
    }
    const detach = attachAutomationController(store, api)
    await tick()

    const automation = store.getState().threads[0]?.automation
    assert.equal(automation?.failure?.code, failure.code)
    assert.equal(automation.failure.message, failure.message)
    assert.ok(automation.startFailedAt !== undefined)
    assert.equal(reports.length, 1)
    assert.equal(reports[0]?.code, failure.code)
    assert.equal(reports[0].projectId, 'project-a')

    assert.equal(dispatches, 0)
    assert.equal(store.getState().threads[0]?.draftPrompt, 'Review CI and report any failures.')
    assert.equal(
      store.getState().threads[0]?.messages.filter((message) => message.role === 'user').length,
      0,
    )
    detach()
  })
}

test('a trigger for an inactive project remains persisted until that project opens', async () => {
  const created = automationThread()
  const store = createStore({
    activeProjectId: 'project-a',
    workspaceRoot: '/repo/a',
    threads: [],
  })
  const harness = controllerApi([created])
  const detach = attachAutomationController(store, harness.api)

  harness.emitTrigger({
    projectId: 'project-b',
    scheduleId: 'schedule-ci',
    threadId: created.id,
    triggeredAt: 100,
    disposition: 'started',
  })
  await tick()

  assert.equal(harness.prepared.length, 0)
  assert.equal(harness.runs.length, 0)

  store.setState({
    activeProjectId: 'project-b',
    workspaceRoot: '/repo/b',
    threads: [created],
  })
  await tick()

  assert.equal(harness.prepared.length, 1)
  assert.equal(harness.runs.length, 1)

  detach()
})

test('a run whose start failed is not started again when the workspace reloads', async (context) => {
  context.mock.method(console, 'error', () => {})
  const store = createStore({
    activeProjectId: 'project-a',
    workspaceRoot: '/repo',
    threads: [automationThread()],
  })
  let checkouts = 0
  const api: AutomationControllerApi = {
    agent: {
      prepareCheckout: () => {
        checkouts += 1
        return Promise.reject(new Error('checkout unavailable'))
      },
      run: () => Promise.resolve(),
    },
    automations: {
      list: () => Promise.resolve([]),
      listBranchCi: () => Promise.resolve([]),
      onTriggered: () => () => {},
      canStart: () => Promise.resolve({ allowed: true }),
      reportStartFailure: () => Promise.resolve(true),
    },
    threads: {
      loadMessages: () => Promise.resolve([]),
      loadProject: () => Promise.resolve([]),
    },
  }
  const detach = attachAutomationController(store, api)
  await tick()
  assert.equal(checkouts, 1)

  // Leave the project and come back: each selection re-runs the pending scan.
  store.setState({ activeProjectId: 'project-b', workspaceRoot: '/repo/b' })
  await tick()
  store.setState({ activeProjectId: 'project-a', workspaceRoot: '/repo' })
  await tick()

  assert.equal(checkouts, 1)
  assert.equal(store.getState().threads[0]?.draftPrompt, 'Review CI and report any failures.')
  detach()
})

test('a main-owned turn opened mid-run refreshes its final transcript without redispatch', async () => {
  const created = automationThread()
  created.draftPrompt = 'Followup draft'
  created.status = 'running'
  const store = createStore({
    projects: [{ id: 'project-a', path: '/repo', name: 'A' }],
    activeProjectId: 'project-a',
    activeThreadId: created.id,
    threads: [created],
  })
  const settled: Thread = { ...created, status: 'idle', draftPrompt: '' }
  const { api, emitTrigger, runs } = controllerApi([settled])
  const messages: Thread['messages'] = [
    {
      id: 'headless-answer',
      role: 'assistant',
      content: 'Review complete.',
      toolCalls: [],
      createdAt: 200,
    },
  ]
  api.threads.loadMessages = (): Promise<Thread['messages']> => Promise.resolve(messages)
  const dispose = attachAutomationController(store, api)
  emitTrigger({
    projectId: 'project-a',
    scheduleId: 'schedule-ci',
    threadId: created.id,
    triggeredAt: 100,
    disposition: 'started',
    headlessSettled: true,
  })
  await tick()
  assert.equal(store.getState().threads[0]?.status, 'idle')
  assert.deepEqual(store.getState().threads[0]?.messages, messages)
  assert.equal(store.getState().threads[0]?.messagesLoaded, true)
  assert.equal(store.getState().threads[0]?.draftPrompt, 'Followup draft')
  assert.equal(runs.length, 0)
  dispose()
})

test('a settled-headless read cannot overwrite the project selected during its fetch', async () => {
  const created = automationThread()
  created.draftPrompt = ''
  created.status = 'running'
  const store = createStore({
    projects: [{ id: 'project-a', path: '/repo', name: 'A' }],
    activeProjectId: 'project-a',
    threads: [created],
  })
  const { api, emitTrigger } = controllerApi([{ ...created, status: 'idle' }])
  let finish: (messages: Thread['messages']) => void = () => {}
  api.threads.loadMessages = (): Promise<Thread['messages']> =>
    new Promise((resolve) => {
      finish = resolve
    })
  const dispose = attachAutomationController(store, api)
  emitTrigger({
    projectId: 'project-a',
    scheduleId: 'schedule-ci',
    threadId: created.id,
    triggeredAt: 100,
    disposition: 'started',
    headlessSettled: true,
  })
  await tick()
  const other = { ...created, id: 'other-thread' }
  store.setState({ activeProjectId: 'project-b', threads: [other] })
  finish([])
  await tick()
  assert.deepEqual(store.getState().threads, [other])
  dispose()
})

test('a settled-headless read cannot replace a newer interactive turn', async () => {
  const created = automationThread()
  created.draftPrompt = ''
  created.status = 'running'
  const store = createStore({
    projects: [{ id: 'project-a', path: '/repo', name: 'A' }],
    activeProjectId: 'project-a',
    threads: [created],
  })
  const { api, emitTrigger } = controllerApi([{ ...created, status: 'idle' }])
  let finish: (messages: Thread['messages']) => void = () => {}
  api.threads.loadMessages = (): Promise<Thread['messages']> =>
    new Promise((resolve) => {
      finish = resolve
    })
  const dispose = attachAutomationController(store, api)
  emitTrigger({
    projectId: 'project-a',
    scheduleId: 'schedule-ci',
    threadId: created.id,
    triggeredAt: 100,
    disposition: 'started',
    headlessSettled: true,
  })
  await tick()
  const next: Thread = {
    ...created,
    messages: [
      {
        id: 'next-user-turn',
        role: 'user',
        content: 'Next request',
        toolCalls: [],
        createdAt: 300,
      },
    ],
  }
  store.setState({ threads: [next] })
  finish([])
  await tick()
  assert.deepEqual(store.getState().threads, [next])
  dispose()
})

for (const phase of ['metadata', 'messages']) {
  test(`a headless completion cannot stop a persisted newer turn during its ${phase} read`, async () => {
    const created = automationThread()
    created.status = 'running'
    created.draftPrompt = ''
    const settled: Thread = { ...created, status: 'idle' }
    const store = createStore({
      projects: [{ id: 'project-a', path: '/repo', name: 'A' }],
      activeProjectId: 'project-a',
      threads: [created],
    })
    const { api, emitTrigger, runs } = controllerApi([settled])
    let finishMetadata: (threads: Thread[]) => void = () => {}
    let finishMessages: (messages: Thread['messages']) => void = () => {}
    if (phase === 'metadata') {
      api.threads.loadProject = (): Promise<Thread[]> =>
        new Promise((resolve) => {
          finishMetadata = resolve
        })
    }
    api.threads.loadMessages = (): Promise<Thread['messages']> =>
      new Promise((resolve) => {
        finishMessages = resolve
      })
    const dispose = attachAutomationController(store, api)
    emitTrigger({
      projectId: 'project-a',
      scheduleId: 'schedule-ci',
      threadId: created.id,
      triggeredAt: 100,
      disposition: 'started',
      headlessSettled: true,
    })
    await tick()
    // Reach the actual interactive entry points, then emulate their completed
    // persistence: the late transcript read includes this new user's ID.
    startHumanTurnTree(store, created.id)
    addMessage(store, created.id, 'user', 'A newer request that is already on disk')
    setThreadStatus(store, created.id, 'running')
    const newer = getThreadById(store, created.id)
    assert.ok(newer)
    finishMetadata([settled])
    await tick()
    finishMessages(newer.messages)
    await tick()
    assert.equal(getThreadById(store, created.id), newer)
    assert.equal(getThreadById(store, created.id)?.status, 'running')
    assert.equal(runs.length, 0)
    dispose()
  })
}

test(
  'a delayed headless transcript cannot autosave over a newer main-owned retirement',
  { timeout: 5_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-retirement-producer-'))
    configureThreadStore({ workspaceRoot: () => root, listProjectIds: () => ['project-a'] })
    __resetPersistenceForTest()
    let detach = (): void => undefined
    try {
      const created = automationThread('retired-run')
      created.status = 'running'
      created.draftPrompt = ''
      created.worktree = {
        path: join(root, 'checkout'),
        branch: 'copse/finished-run',
        baseBranch: 'main',
        baseCommit: 'a'.repeat(40),
        createdAt: 100,
        seededFromDirtyProject: false,
      }
      await createStoredThread('project-a', created)
      const store = createStore({
        projects: [{ id: 'project-a', path: '/repo', name: 'A' }],
        activeProjectId: 'project-a',
        threads: [created],
      })
      const harness = controllerApi([])
      const base = createFakeApi()
      const api = {
        ...base,
        agent: { ...base.agent, ...harness.api.agent },
        automations: { ...base.automations, ...harness.api.automations },
        threads: { ...base.threads, ...harness.api.threads },
      }
      api.threads.loadProject = (): Promise<Thread[]> => loadProjectThreadMetas('project-a')
      const patches: Array<Record<string, unknown>> = []
      api.threads.updateMeta = (projectId, threadId, patch): Promise<void> => {
        patches.push({ ...patch })
        return updateMeta(projectId, threadId, withoutMainOwnedThreadFields({ ...patch }))
      }
      await loadThreads(api, 'project-a')
      await updateMeta('project-a', created.id, { status: 'idle', updatedAt: 200 })
      const messages: Thread['messages'] = [
        {
          id: 'settled-answer',
          role: 'assistant',
          content: 'Finished.',
          toolCalls: [],
          createdAt: 200,
        },
      ]
      let releaseFirst = (_messages: Thread['messages']): void => undefined
      let reachedMessages = (): void => undefined
      const messagesStarted = new Promise<void>((resolve): void => {
        reachedMessages = resolve
      })
      let messageReads = 0
      api.threads.loadMessages = (): Promise<Thread['messages']> => {
        if (++messageReads > 1) return Promise.resolve(messages)
        reachedMessages()
        return new Promise<Thread['messages']>((resolve) => {
          releaseFirst = resolve
        })
      }
      detach = attachAutomationController(store, api)
      harness.emitTrigger({
        projectId: 'project-a',
        scheduleId: 'schedule-ci',
        threadId: created.id,
        triggeredAt: 100,
        disposition: 'started',
        headlessSettled: true,
      })
      await messagesStarted
      await updateMeta('project-a', created.id, {
        worktree: { ...created.worktree, retiredAt: 300 },
      })
      // A supported fresh metadata read completes after cleanup, before the old
      // transcript request returns. Keep that main-owned result visible locally.
      invalidateProjectThreadLoads(api, 'project-a')
      const retired = await loadThreads(api, 'project-a')
      assert.equal(retired[0]?.worktree?.retiredAt, 300)
      store.setState({ threads: retired })
      let unsubscribe = (): void => undefined
      const applied = new Promise<void>((resolve): void => {
        unsubscribe = store.on('threads_changed', () => {
          unsubscribe()
          resolve()
        })
      })
      releaseFirst(messages)
      await applied
      await flushProjectThreads(api, 'project-a', store.getState().threads)
      const saved = await getThreadMeta('project-a', created.id)
      console.log(
        '[retirement-producer]',
        JSON.stringify({
          worktreePatches: patches.filter((patch) => Object.hasOwn(patch, 'worktree')),
          storedWorktree: saved?.worktree,
          rendererWorktree: getThreadById(store, created.id)?.worktree,
          dispatchedRuns: harness.runs.length,
        }),
      )
      assert.equal(saved?.worktree?.retiredAt, 300)
      assert.equal(getThreadById(store, created.id)?.worktree?.retiredAt, 300)
      assert.deepEqual(getThreadById(store, created.id)?.messages, messages)
      assert.equal(harness.runs.length, 0)
    } finally {
      detach()
      __resetPersistenceForTest()
      configureThreadStore()
      rmSync(root, { recursive: true, force: true })
    }
  },
)

for (const owner of ['active', 'carried']) {
  for (const invalidated of [false, true]) {
    test(`a headless completion preserves a cleared ${owner} draft with metadata invalidation ${String(invalidated)}`, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'copse-clear-headless-draft-'))
      configureThreadStore({
        workspaceRoot: () => root,
        listProjectIds: () => ['project-a', 'project-b'],
      })
      __resetPersistenceForTest()
      resetProjectSwitchStateForTest()
      let detachController = (): void => undefined
      let detachAutosave = (): void => undefined
      try {
        const prompt: Thread['messages'][number] = {
          id: 'submitted-prompt',
          role: 'user',
          content: 'Review CI.',
          toolCalls: [],
          createdAt: 100,
        }
        const partial: Thread['messages'][number] = {
          id: 'answer',
          role: 'assistant',
          content: 'Checking',
          toolCalls: [],
          createdAt: 110,
        }
        const created: Thread = {
          id: 'run-a',
          title: 'CI review',
          status: 'running',
          messages: [prompt, partial],
          messagesLoaded: true,
          usage: { inputTokens: 0, outputTokens: 0 },
          model: 'mock-model',
          draftPrompt: 'Previously saved follow-up',
          automation: {
            scheduleId: 'schedule-ci',
            scheduleName: 'CI review',
            triggeredAt: 100,
          },
          createdAt: 100,
          updatedAt: 110,
        }
        const notesPrompt = { ...prompt, id: 'notes-prompt', content: 'Notes.' }
        const other: Thread = {
          id: 'notes-b',
          title: 'Notes',
          status: 'idle',
          messages: [notesPrompt],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: 100,
          updatedAt: 100,
        }
        await createStoredThread('project-a', created)
        await appendMessage('project-a', created.id, prompt)
        await appendMessage('project-a', created.id, partial)
        await createStoredThread('project-b', other)
        await appendMessage('project-b', other.id, notesPrompt)
        const store = createStore({
          projects: [
            { id: 'project-a', path: '/repo/a', name: 'A' },
            { id: 'project-b', path: '/repo/b', name: 'B' },
          ],
          activeProjectId: 'project-a',
          activeThreadId: created.id,
          workspaceRoot: '/repo/a',
          threads: [created],
        })
        const api = createFakeApi()
        api.workspace.set = async (path): Promise<string> => path
        api.threads.loadProject = async (projectId): Promise<Thread[]> =>
          structuredClone(await loadProjectThreadMetas(projectId))
        const patches: Array<{ projectId: string; threadId: string; patch: unknown }> = []
        api.threads.updateMeta = (projectId, threadId, patch): Promise<void> => {
          patches.push({ projectId, threadId, patch: { ...patch } })
          return updateMeta(projectId, threadId, withoutMainOwnedThreadFields({ ...patch }))
        }
        api.threads.create = createStoredThread
        api.threads.appendMessage = appendMessage
        let trigger: ((event: AutomationTriggerEvent) => void) | undefined
        api.automations.onTriggered = (handler): (() => void) => {
          trigger = handler
          return (): void => {
            trigger = undefined
          }
        }
        let prepared = 0
        let dispatched = 0
        api.agent.prepareCheckout = async (): Promise<never> => {
          prepared++
          throw new Error('Unexpected checkout preparation')
        }
        api.agent.run = async (): Promise<void> => {
          dispatched++
        }
        await loadThreads(api, 'project-a')
        const completed = { ...partial, content: 'CI review completed.' }
        await appendMessage('project-a', created.id, completed)
        await updateMeta('project-a', created.id, { status: 'idle', updatedAt: 200 })
        let releaseFirst = (): void => undefined
        let enteredMessages = (): void => undefined
        const messagesEntered = new Promise<void>((resolve): void => {
          enteredMessages = resolve
        })
        let reads = 0
        api.threads.loadMessages = async (projectId, threadId): Promise<Thread['messages']> => {
          if (++reads === 1) {
            enteredMessages()
            await new Promise<void>((resolve): void => {
              releaseFirst = resolve
            })
          }
          return loadThreadMessages(projectId, threadId)
        }
        t.mock.timers.enable({ apis: ['setTimeout'] })
        const autosave = attachAutosave(store, api)
        detachAutosave = (): void => {
          autosave.detach()
        }
        detachController = attachAutomationController(store, api)
        assert.ok(trigger)
        const revisionBefore = projectThreadLoadRevision(api, 'project-a')
        trigger({
          projectId: 'project-a',
          scheduleId: 'schedule-ci',
          threadId: created.id,
          triggeredAt: 100,
          disposition: 'started',
          headlessSettled: true,
        })
        await messagesEntered
        setThreadDraftPrompt(store, created.id, '')
        const afterHelper = getThreadById(store, created.id)
        assert.equal(Object.hasOwn(afterHelper ?? {}, 'draftPrompt'), false)
        // Advance only the actual autosave debounce; do not force a save or
        // manufacture a controller revision. Main's real guard writes the patch.
        t.mock.timers.tick(AUTOSAVE_DEBOUNCE_MS)
        await autosave.whenIdle()
        const diskAfterClear = await getThreadMeta('project-a', created.id)
        assert.ok(diskAfterClear)
        const revisionAfterSave = projectThreadLoadRevision(api, 'project-a')
        if (owner === 'carried') {
          await switchProjectAndWait(store, api, 'project-b')
          assert.equal(store.getState().activeProjectId, 'project-b')
          assert.equal(store.getState().backgroundThreads[0]?.thread.id, created.id)
        }
        if (invalidated) invalidateProjectThreadLoads(api, 'project-a')
        let unsubscribe = (): void => undefined
        const applied = new Promise<void>((resolve): void => {
          unsubscribe = store.on('threads_changed', (): void => {
            const current = getThreadById(store, created.id)
            if (current?.status !== 'idle') return
            unsubscribe()
            resolve()
          })
        })
        releaseFirst()
        await applied
        const restored = getThreadById(store, created.id)
        const completionReads = reads
        // Re-enter through real navigation so the carried copy is adopted and
        // the normal active-project autosave can run after completion too.
        if (owner === 'carried') await switchProjectAndWait(store, api, 'project-a')
        t.mock.timers.tick(AUTOSAVE_DEBOUNCE_MS)
        await autosave.whenIdle()
        const diskAfterCompletion = await getThreadMeta('project-a', created.id)
        assert.ok(diskAfterCompletion)
        const result = {
          owner,
          invalidated,
          revisionBefore,
          revisionAfterSave,
          revisionAfter: projectThreadLoadRevision(api, 'project-a'),
          reads: completionReads,
          helperHasDraft: Object.hasOwn(afterHelper ?? {}, 'draftPrompt'),
          diskAfterClear: diskAfterClear.draftPrompt ?? null,
          rendererAfterCompletion: restored?.draftPrompt ?? null,
          diskAfterCompletion: diskAfterCompletion.draftPrompt ?? null,
          rendererHasDraft: Object.hasOwn(restored ?? {}, 'draftPrompt'),
          activeProjectId: store.getState().activeProjectId,
          status: restored?.status,
          epoch: restored?.currentEpoch ?? null,
          automation: restored?.automation,
          messageIds: restored?.messages.map((message) => message.id),
          contents: restored?.messages.map((message) => message.content),
          patches,
          prepared,
          dispatched,
        }
        console.log('[clear-headless-draft-control]', JSON.stringify(result))
        assert.equal(diskAfterClear.draftPrompt, undefined)
        assert.equal(restored?.draftPrompt, undefined)
        assert.equal(diskAfterCompletion.draftPrompt, undefined)
        assert.deepEqual(restored?.messages, [prompt, completed])
        assert.equal(prepared, 0)
        assert.equal(dispatched, 0)
        assert.equal(revisionAfterSave, revisionBefore)
        assert.equal(completionReads, invalidated ? 2 : 1)
      } finally {
        detachController()
        detachAutosave()
        t.mock.timers.reset()
        closeThreadStoreIndexes()
        __resetPersistenceForTest()
        resetProjectSwitchStateForTest()
        configureThreadStore()
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
}
