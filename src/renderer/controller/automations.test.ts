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
import { addMessage, getThreadById, setThreadStatus } from '@shared/store/thread-helpers.ts'
import { startHumanTurnTree } from './message-queue.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { attachThreadHydration } from './thread-hydration.ts'
import { withoutMainOwnedThreadFields } from '../../main/ipc/thread-meta-guard.ts'
import {
  createThread as createStoredThread,
  getThreadMeta,
  loadProjectThreadMetas,
  updateMeta,
} from '../../main/services/thread-store.ts'
import {
  __resetPersistenceForTest,
  flushProjectThreads,
  invalidateProjectThreadLoads,
  loadThreads,
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
  const store = createStore({ activeProjectId: 'project-a', threads: [created] })
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
  const store = createStore({ activeProjectId: 'project-a', threads: [created] })
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
    const store = createStore({ activeProjectId: 'project-a', threads: [created] })
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
      const store = createStore({ activeProjectId: 'project-a', threads: [created] })
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
