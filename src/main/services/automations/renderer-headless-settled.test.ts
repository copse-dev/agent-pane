import '../../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AutomationTriggerEvent, Thread } from '@shared/types'
import { createStore } from '@shared/store/store.ts'
import { getThreadById } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../../preload/api.d.ts'
import { createFakeApi } from '../../../renderer/fake-api.test-support.ts'
import { mountProjectsPane } from '../../../renderer/views/projects-pane.ts'
import { attachAutomationController } from '../../../renderer/controller/automations.ts'
import { carryRunningThreads } from '../../../renderer/controller/background-threads.ts'
import {
  attachProjectThreadCache,
  resetProjectSwitchStateForTest,
} from '../../../renderer/controller/projects.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import { runWithToolAvailability } from '../tool-availability.ts'
import {
  closeThreadStoreIndexes,
  createThread,
  getThreadMeta,
  loadProjectThreads,
  loadThreadMessages,
} from '../thread-store.ts'
import { createAutomationService, type AutomationTaskSupervisor } from './automation-service.ts'

const A = 'inactive-settled-a'
const B = 'inactive-settled-b'
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Completion barrier timed out: ${label}`))
        }, 15_000)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function idleThread(): Thread {
  return {
    id: 'active-b',
    title: 'Current B',
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

async function scenario(stayActive: boolean): Promise<void> {
  resetProjectSwitchStateForTest()
  const root = mkdtempSync(join(tmpdir(), 'copse-inactive-settled-diagnostic-'))
  const previousWorkspace = process.env['COPSE_WORKSPACE_DIR']
  const previousWorktrees = process.env['COPSE_WORKTREES_DIR']
  const previousProjects = storageGet('projects')
  const previousSchedules = storageGet('plugin.copse.automations.storage')
  process.env['COPSE_WORKSPACE_DIR'] = join(root, 'workspace')
  process.env['COPSE_WORKTREES_DIR'] = join(root, 'worktrees')
  const projectA = join(root, 'project-a')
  const projectB = join(root, 'project-b')
  mkdirSync(projectA)
  mkdirSync(projectB)
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: projectA, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Copse Diagnostic')
  git('config', 'user.email', 'diagnostic@example.invalid')
  writeFileSync(join(projectA, 'README.md'), 'A headless completion diagnostic.\n')
  git('add', 'README.md')
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'seed')
  storageSet('projects', [
    { id: A, path: projectA, name: 'Project A' },
    { id: B, path: projectB, name: 'Project B' },
  ])
  storageSet('plugin.copse.automations.storage', [])
  const currentB = idleThread()
  const store = createStore({
    activeProjectId: B,
    expandedProjectId: B,
    activeThreadId: currentB.id,
    workspaceRoot: projectB,
    projects: [
      { id: A, path: projectA, name: 'Project A' },
      { id: B, path: projectB, name: 'Project B' },
    ],
    threads: [currentB],
  })
  const listeners = new Set<(event: AutomationTriggerEvent) => void>()
  const notifications: AutomationTriggerEvent[] = []
  let releaseDispatch: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    releaseDispatch = resolve
  })
  let enteredDispatch: (id: string) => void = () => {}
  const entered = new Promise<string>((resolve) => {
    enteredDispatch = resolve
  })
  let deliveredSettled: (event: AutomationTriggerEvent) => void = () => {}
  const settled = new Promise<AutomationTriggerEvent>((resolve) => {
    deliveredSettled = resolve
  })
  const supervisor: AutomationTaskSupervisor = {
    start: () => Promise.resolve(),
    syncCronTasks: () => {},
    list: () => [],
    cancel: () => Promise.resolve(null),
    enqueue: () => Promise.reject(new Error('No cron wake expected in this diagnostic')),
    registerHandler: () => () => {},
    subscribe: () => () => {},
  }
  const service = createAutomationService({
    now: () => Date.now(),
    isPluginEnabled: () => true,
    createProjectThread: createThread,
    releasePreviousRun: () => Promise.resolve({ released: true }),
    supervisor: () => supervisor,
  })
  const base = createFakeApi()
  let dispatchedFromRenderer = 0
  let dispatchDoneEmitted = false
  let settledDisk: { meta: Buffer; spine: Buffer } | undefined
  const rendererWrites: string[] = []
  let stopStatusObserver: () => void = () => {}
  const api: ApiClient = {
    ...base,
    agent: {
      ...base.agent,
      run: () => {
        dispatchedFromRenderer++
        return Promise.resolve()
      },
      prepareCheckout: (...args) => {
        rendererWrites.push('prepareCheckout')
        return base.agent.prepareCheckout(...args)
      },
    },
    threads: {
      ...base.threads,
      loadProject: (project) => loadProjectThreads(project),
      loadMessages: (project, id) => loadThreadMessages(project, id),
      listOrphans: () => Promise.resolve([]),
      create: (...args) => {
        rendererWrites.push('create')
        return base.threads.create(...args)
      },
      appendMessage: (...args) => {
        rendererWrites.push('appendMessage')
        return base.threads.appendMessage(...args)
      },
      updateMeta: (...args) => {
        rendererWrites.push('updateMeta')
        return base.threads.updateMeta(...args)
      },
    },
    automations: {
      ...base.automations,
      list: (project) => Promise.resolve(service.list(project)),
      listBranchCi: () => Promise.resolve([]),
      onTriggered: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
  }
  const detachAutomation = attachAutomationController(store, api)
  const detachCache = attachProjectThreadCache(store)
  const host = document.createElement('div')
  document.body.append(host)
  const detachPane = mountProjectsPane(host, store, api)
  service.start(
    (event) => {
      notifications.push(event)
      if (event.headlessSettled) {
        const threadRoot = join(root, 'workspace', A, event.threadId)
        settledDisk = {
          meta: readFileSync(join(threadRoot, 'meta.json')),
          spine: readFileSync(join(threadRoot, 'events.jsonl')),
        }
      }
      for (const listener of listeners) listener(event)
      if (event.headlessSettled) deliveredSettled(event)
    },
    async (request, target) => {
      enteredDispatch(request.threadId)
      await held
      target.emit(request.threadId, { type: 'text', text: 'The real headless turn finished.' })
      target.emit(request.threadId, { type: 'done' })
      dispatchDoneEmitted = true
    },
    () => store.getState().activeProjectId,
  )
  try {
    const schedule = await service.upsert(A, {
      name: 'Headless Project A',
      cron: '* * * * *',
      prompt: 'Check Project A.',
      model: 'mock-model',
      enabled: false,
    })
    const trigger = await runWithToolAvailability({ git: true, rg: false, gh: false }, () =>
      service.runNow(A, schedule.id),
    )
    const id = await bounded(entered, 'actual headless dispatcher entered')
    assert.equal(id, trigger.threadId)
    const opened = await loadProjectThreads(A)
    assert.equal(opened.find((thread) => thread.id === id)?.status, 'running')
    // The actual carry helper models opening A mid-run and navigating away.
    store.setState({
      activeProjectId: A,
      expandedProjectId: A,
      workspaceRoot: projectA,
      threads: opened,
      activeThreadId: id,
    })
    store.emit('threads_changed')
    if (!stayActive) {
      carryRunningThreads(store, A, opened)
      store.setState({
        activeProjectId: B,
        expandedProjectId: B,
        workspaceRoot: projectB,
        threads: [currentB],
        activeThreadId: currentB.id,
      })
      store.emit('threads_changed')
    }
    store.emit('projects_changed')
    assert.equal(getThreadById(store, id)?.status, 'running')
    const projectRow = (): Element | null =>
      host.querySelector(`.project-entry[data-project-id="${A}"] .project-row`)
    const indicator = (): Element | null =>
      stayActive ? host.querySelector(`.chat-row[data-thread-id="${id}"]`) : projectRow()
    assert.equal(indicator()?.classList.contains('is-running'), true)
    const globalRunning = (): Element | null =>
      host.querySelector('.automation-threads-toggle .automation-threads-running')
    assert.equal(globalRunning() !== null, true)
    const rendererIdle = new Promise<void>((resolve) => {
      stopStatusObserver = store.on('threads_changed', () => {
        if (getThreadById(store, id)?.status === 'idle') resolve()
      })
    })
    releaseDispatch()
    const actualSettledEvent = await bounded(settled, 'actual headless settlement delivered')
    // This is the real main producer's final event, after flush, idle and its
    // actual friendly Git branch rename, not a hand-written event payload.
    assert.equal(actualSettledEvent.threadId, id)
    const durable = await getThreadMeta(A, id)
    assert.equal(durable?.status, 'idle')
    assert.ok(durable.worktree?.branch.startsWith('copse/headless-project-a-'))
    assert.equal(durable.currentEpoch, undefined)
    const checkout = durable.worktree
    assert.ok(checkout)
    const physicalBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: checkout.path,
      encoding: 'utf8',
    }).trim()
    assert.equal(physicalBranch, checkout.branch)
    assert.equal(dispatchDoneEmitted, true)
    await bounded(rendererIdle, 'the owning renderer projection actually refreshed idle')
    assert.equal(dispatchedFromRenderer, 0)
    assert.equal(store.getState().activeProjectId, stayActive ? A : B)
    assert.equal(store.getState().activeThreadId, stayActive ? id : currentB.id)
    assert.equal(getThreadById(store, id)?.status, 'idle')
    assert.equal(indicator()?.classList.contains('is-running'), false)
    assert.equal(globalRunning() !== null, false, 'the global automation indicator must settle too')
    assert.deepEqual(getThreadById(store, id)?.messages, await loadThreadMessages(A, id))
    assert.equal(getThreadById(store, id)?.messagesLoaded, true)
    assert.deepEqual(rendererWrites, [])
    assert.ok(settledDisk)
    assert.deepEqual(readFileSync(join(root, 'workspace', A, id, 'meta.json')), settledDisk.meta)
    assert.deepEqual(
      readFileSync(join(root, 'workspace', A, id, 'events.jsonl')),
      settledDisk.spine,
    )
  } finally {
    releaseDispatch()
    service.stop()
    detachAutomation()
    detachCache()
    detachPane()
    stopStatusObserver()
    host.remove()
    resetProjectSwitchStateForTest()
    closeThreadStoreIndexes()
    storageSet('projects', previousProjects)
    storageSet('plugin.copse.automations.storage', previousSchedules)
    if (previousWorkspace === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousWorkspace
    if (previousWorktrees === undefined) delete process.env['COPSE_WORKTREES_DIR']
    else process.env['COPSE_WORKTREES_DIR'] = previousWorktrees
    rmSync(root, { recursive: true, force: true })
  }
}

test('refreshes a real main-owned completion while its project remains active', () =>
  scenario(true))

test('refreshes the authoritative history of a real completed carried headless turn', () =>
  scenario(false))
