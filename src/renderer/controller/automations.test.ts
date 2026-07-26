import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import type { AutomationTriggerEvent, Thread } from '@shared/types'
import type { PreparedThreadCheckout } from '@shared/types/worktree.ts'
import { attachAutomationController, type AutomationControllerApi } from './automations.ts'

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
      onTriggered(handler) {
        triggerHandler = handler
        return () => {
          triggerHandler = null
        }
      },
    },
    threads: {
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
  })
  await tick()
  await tick()

  assert.deepEqual(harness.prepared, [
    {
      projectId: 'project-a',
      threadId: created.id,
      prompt: 'Review CI and report any failures.',
      choice: 'automatic',
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
      onTriggered: () => () => {},
    },
    threads: {
      loadProject: () => Promise.resolve([]),
    },
  }
  const detach = attachAutomationController(store, api)

  await tick()

  const thread = store.getState().threads[0]
  assert.ok(thread)
  assert.equal(thread.status, 'idle')
  assert.equal(thread.draftPrompt, 'Review CI and report any failures.')
  assert.equal(thread.messages.length, 0)
  assert.equal(runs, 0)

  detach()
})

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
  })
  await tick()

  assert.equal(harness.prepared.length, 0)
  assert.equal(harness.runs.length, 0)

  store.setState({
    activeProjectId: 'project-b',
    workspaceRoot: '/repo/b',
    threads: [created],
  })
  store.emit('workspace_changed')
  await tick()

  assert.equal(harness.prepared.length, 1)
  assert.equal(harness.runs.length, 1)

  detach()
})
