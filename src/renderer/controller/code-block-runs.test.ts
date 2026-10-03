import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import type { CodeBlockRunResult } from '@shared/store/events.ts'
import { getThreadById } from '@shared/store/thread-helpers.ts'
import type { MachineAgentRunRequest, MachineDispatchResult, Thread } from '@shared/types'
import { sendCodeBlockRunResult, type CodeBlockRunSendApi } from './code-block-runs.ts'

function runThread(status: Thread['status']): Thread {
  return {
    id: 'thread-1',
    title: 'Tests',
    status,
    messages: [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '```sh\npnpm test\n```',
        toolCalls: [],
        createdAt: 1,
      },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

function result(threadId = 'thread-1'): CodeBlockRunResult {
  return {
    id: 'run-1',
    projectId: 'project-1',
    threadId,
    exitCode: 1,
    output: 'FAIL',
    shell: {
      tabId: 'terminal-1',
      label: 'Run · pnpm test · exit 1',
      content: 'Command:\npnpm test\n\nExit code: 1\n\nTerminal output:\nFAIL',
    },
  }
}

function sendApi(machineResult: MachineDispatchResult = 'completed'): {
  api: CodeBlockRunSendApi
  runs: string[]
  machineRuns: MachineAgentRunRequest[]
} {
  const runs: string[] = []
  const machineRuns: MachineAgentRunRequest[] = []
  return {
    runs,
    machineRuns,
    api: {
      agent: {
        run: async (_projectId, threadId): Promise<void> => {
          runs.push(threadId)
        },
        runMachine: async (request): Promise<MachineDispatchResult> => {
          machineRuns.push(request)
          return machineResult
        },
      },
      git: {
        currentBranch: async () => 'main',
        promptState: async () => ({ startingCommit: 'a'.repeat(40), dirty: true }),
      },
      settings: {
        get: async () => true,
      },
    },
  }
}

function storeWith(thread: Thread): ReturnType<typeof createStore> {
  return createStore({
    projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
    activeProjectId: 'project-1',
    activeThreadId: thread.id,
    threads: [thread],
  })
}

test('a result for a busy thread queues behind the running turn', async () => {
  const store = storeWith(runThread('running'))
  const { api, runs } = sendApi()

  assert.equal(await sendCodeBlockRunResult(store, api, result()), true)

  assert.deepEqual(runs, [], 'nothing interrupts the running turn')
  const thread = getThreadById(store, 'thread-1')
  const sent = thread?.messages.at(-1)
  assert.equal(sent?.role, 'user')
  assert.equal(sent.startingCommit, 'a'.repeat(40))
  assert.equal(sent.dirty, true)
  const queued = thread?.pendingMessages ?? []
  const [item, ...rest] = queued
  assert.ok(item)
  assert.equal(rest.length, 0)
  assert.equal(item.messageId, sent.id)
  assert.match(JSON.stringify(item.payload.content), /Shell: Run · pnpm test · exit 1/)
})

test('a result for a thread that no longer exists is not sent', async () => {
  const store = storeWith(runThread('idle'))
  const { api, runs } = sendApi()

  assert.equal(await sendCodeBlockRunResult(store, api, result('deleted-thread')), false)

  assert.deepEqual(runs, [])
  assert.equal(getThreadById(store, 'thread-1')?.messages.length, 1)
})

test('a result from a background project cannot target a same-id active thread', async () => {
  const thread = runThread('idle')
  const store = createStore({
    projects: [
      { id: 'project-1', name: 'Origin', path: '/origin' },
      { id: 'project-2', name: 'Active', path: '/active' },
    ],
    activeProjectId: 'project-2',
    activeThreadId: thread.id,
    threads: [thread],
  })
  const { api, runs } = sendApi()

  assert.equal(await sendCodeBlockRunResult(store, api, result()), false)

  assert.deepEqual(runs, [])
  assert.equal(getThreadById(store, thread.id)?.messages.length, 1)
})

test('a project switch during async guards cannot target a same-id active thread', async () => {
  const origin = runThread('idle')
  const store = storeWith(origin)
  const { api, runs } = sendApi()
  let allowSettings: ((value: boolean) => void) | undefined
  let settingsStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    settingsStarted = resolve
  })
  api.settings.get = async (): Promise<boolean> => {
    settingsStarted?.()
    return await new Promise<boolean>((resolve) => {
      allowSettings = resolve
    })
  }

  const sending = sendCodeBlockRunResult(store, api, result())
  await started
  const replacement = runThread('idle')
  store.setState({
    activeProjectId: 'project-2',
    activeThreadId: replacement.id,
    threads: [replacement],
    backgroundThreads: [{ projectId: 'project-1', thread: origin }],
  })
  allowSettings?.(true)

  assert.equal(await sending, false)
  assert.deepEqual(runs, [])
  assert.equal(replacement.messages.length, 1)
  assert.equal(origin.messages.length, 1)
})

test('a result stays as a draft attachment when terminal sharing is disabled', async () => {
  const store = storeWith(runThread('idle'))
  const { api, runs } = sendApi()
  api.settings.get = async (): Promise<boolean> => false

  assert.equal(await sendCodeBlockRunResult(store, api, result()), false)

  assert.deepEqual(runs, [])
  assert.equal(getThreadById(store, 'thread-1')?.messages.length, 1)
})

test('a result is not sent when the checkout branch cannot be read', async () => {
  const store = storeWith({ ...runThread('idle'), gitBranch: 'feature' })
  const { api, runs } = sendApi()
  api.git.currentBranch = async (): Promise<string | null> => {
    throw new Error('git unavailable')
  }

  assert.equal(await sendCodeBlockRunResult(store, api, result()), false)

  assert.deepEqual(runs, [])
  assert.equal(getThreadById(store, 'thread-1')?.messages.length, 1)
})

test('a successful recovery run sends a machine-originated continuation', async () => {
  const store = storeWith({ ...runThread('idle'), currentEpoch: 'tree-current' })
  const { api, runs, machineRuns } = sendApi()
  const recovery: CodeBlockRunResult = {
    ...result(),
    exitCode: 0,
    completion: {
      type: 'continue',
      prompt: 'Continue after the Git recovery command completed.',
      operationId: 'git-recovery:test',
      turnTreeId: 'tree-current',
    },
  }

  assert.equal(await sendCodeBlockRunResult(store, api, recovery), true)
  assert.deepEqual(runs, [])
  assert.equal(getThreadById(store, 'thread-1')?.messages.length, 1)
  assert.equal(machineRuns.length, 1)
  const machineRun = machineRuns[0]
  assert.ok(machineRun)
  assert.equal(machineRun.operationId, 'git-recovery:test')
  assert.equal(machineRun.turnTreeId, 'tree-current')
  assert.equal(machineRun.display.content, 'Continue after the Git recovery command completed.')
  assert.deepEqual(machineRun.display.attachments, [
    { kind: 'shell', label: recovery.shell.label, content: recovery.shell.content },
  ])
  assert.equal(machineRun.display.startingCommit, 'a'.repeat(40))
  assert.equal(machineRun.display.dirty, true)
  assert.match(machineRun.payload, /Shell: Run · pnpm test · exit 1/)
  assert.match(getThreadById(store, 'thread-1')?.workingBrief ?? '', /Shell: Run · pnpm test/)
})

test('a recovery continuation follows its thread after its project is backgrounded', async () => {
  const origin = { ...runThread('idle'), currentEpoch: 'tree-current' }
  const active = { ...runThread('idle'), id: 'thread-2' }
  const store = createStore({
    projects: [
      { id: 'project-1', name: 'Origin', path: '/origin' },
      { id: 'project-2', name: 'Active', path: '/active' },
    ],
    activeProjectId: 'project-2',
    activeThreadId: active.id,
    threads: [active],
    backgroundThreads: [{ projectId: 'project-1', thread: origin }],
  })
  const { api, machineRuns } = sendApi()
  const recovery: CodeBlockRunResult = {
    ...result(),
    exitCode: 0,
    completion: {
      type: 'continue',
      prompt: 'Continue after the Git recovery command completed.',
      operationId: 'git-recovery:background',
      turnTreeId: 'tree-current',
    },
  }

  assert.equal(await sendCodeBlockRunResult(store, api, recovery), true)
  assert.equal(machineRuns.length, 1)
  const machineRun = machineRuns[0]
  assert.ok(machineRun)
  assert.equal(machineRun.projectId, 'project-1')
  assert.equal(machineRun.threadId, 'thread-1')
})

test('a stale recovery continuation stays visible for manual follow-up', async () => {
  const store = storeWith({ ...runThread('idle'), currentEpoch: 'tree-new' })
  const { api } = sendApi('stale')
  const recovery: CodeBlockRunResult = {
    ...result(),
    exitCode: 0,
    completion: {
      type: 'continue',
      prompt: 'Continue after the Git recovery command completed.',
      operationId: 'git-recovery:stale',
      turnTreeId: 'tree-old',
    },
  }

  assert.equal(await sendCodeBlockRunResult(store, api, recovery), false)
  assert.match(
    String(getThreadById(store, 'thread-1')?.messages.at(-1)?.content),
    /thread advanced.*Send a message to continue/,
  )
  assert.equal(getThreadById(store, 'thread-1')?.workingBrief, undefined)
})
