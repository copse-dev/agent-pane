import { saveProjectThread } from '../thread-store.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { TaskSupervisor } from '../supervisor/task-supervisor.ts'
import { FileSupervisedTaskStore } from '../supervisor/task-store.ts'
import { listBackgroundProcesses, stopAllBackgroundProcesses } from './background-process.ts'
import {
  hasBackgroundCompletionWake,
  installBackgroundProcessSupervisor,
  runWithBackgroundProcessSupervisor,
  startSupervisedBackgroundProcess,
  stopSupervisedBackgroundProcess,
  stopSupervisedBackgroundProcessesForThread,
} from './supervised-background-process.ts'

async function seedOwner(owner: { projectId: string; threadId: string }): Promise<void> {
  await saveProjectThread(owner.projectId, {
    id: owner.threadId,
    title: 'Background process owner',
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  })
}

const OWNER = { projectId: 'project-a', threadId: 'thread-a' }

async function waitForState(
  supervisor: TaskSupervisor,
  taskId: string,
  state: 'completed' | 'failed',
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (supervisor.get(OWNER.projectId, taskId)?.state === state) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Supervised task ${taskId} did not reach ${state}`)
}

describe('supervised background processes', () => {
  let previousWorkspace: string | undefined
  let root: string
  let supervisor: TaskSupervisor
  let store: FileSupervisedTaskStore
  let dispose: () => void

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'copse-supervised-background-'))
    previousWorkspace = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = root
    await seedOwner(OWNER)
    store = new FileSupervisedTaskStore({ COPSE_WORKSPACE_DIR: root })
    supervisor = new TaskSupervisor({ store })
    dispose = installBackgroundProcessSupervisor(supervisor)
    await supervisor.start()
  })

  afterEach(async () => {
    stopAllBackgroundProcesses()
    await supervisor.shutdown()
    dispose()
    mock.restoreAll()
    if (previousWorkspace === undefined) Reflect.deleteProperty(process.env, 'COPSE_WORKSPACE_DIR')
    else process.env['COPSE_WORKSPACE_DIR'] = previousWorkspace
    rmSync(root, { recursive: true, force: true })
  })

  it('does not treat an unbounded dev server status callback as an agent wake', async () => {
    const info = await startSupervisedBackgroundProcess({
      command: 'sleep 30',
      cwd: process.cwd(),
      waitMs: 10,
      owner: OWNER,
      onCompletion: () => {},
    })
    assert.equal(info.running, true)
    assert.equal(hasBackgroundCompletionWake(OWNER), false)
    assert.equal(await stopSupervisedBackgroundProcess(info.id, OWNER), true)
  })

  it('retains a wake through an early exit, supervisor adoption and async completion delivery', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    try {
      const info = await startSupervisedBackgroundProcess({
        command: 'echo finished',
        cwd: process.cwd(),
        waitMs: 4000,
        owner: OWNER,
        timeoutMs: 5000,
        completionWakeArmed: true,
        onCompletion: async () => {
          entered.resolve(undefined)
          await release.promise
        },
      })
      await entered.promise
      assert.equal(info.running, false)
      assert.equal(hasBackgroundCompletionWake(OWNER), true)
      assert.equal(hasBackgroundCompletionWake({ ...OWNER, projectId: 'other' }), false)
      assert.equal(hasBackgroundCompletionWake({ ...OWNER, threadId: 'other' }), false)
      release.resolve(undefined)
      const deadline = Date.now() + 5000
      while (hasBackgroundCompletionWake(OWNER) && Date.now() < deadline)
        await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(
        hasBackgroundCompletionWake(OWNER),
        false,
        'settled records cannot retain admission',
      )
      assert.equal(
        listBackgroundProcesses(OWNER).some((entry) => entry.id === info.id),
        true,
      )
    } finally {
      release.resolve(undefined)
    }
  })

  it('does not arm a wake after cancellation during the running-record write', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = store.saveTransition.bind(store)
    mock.method(store, 'saveTransition', async (...args: Parameters<typeof original>) => {
      await original(...args)
      if (args[0].state === 'running') {
        entered.resolve(undefined)
        await release.promise
      }
    })
    let completions = 0
    const pending = startSupervisedBackgroundProcess({
      command: 'sleep 30',
      cwd: process.cwd(),
      waitMs: 10,
      owner: OWNER,
      timeoutMs: 5000,
      completionWakeArmed: true,
      onCompletion: () => {
        completions++
      },
    })
    try {
      await entered.promise
      const [task] = supervisor.list(OWNER.projectId)
      assert.ok(task)
      await supervisor.cancel(OWNER.projectId, task.taskId)
      release.resolve(undefined)
      await pending
      assert.equal(hasBackgroundCompletionWake(OWNER), false)
      assert.equal(completions, 0)
      assert.deepEqual(listBackgroundProcesses(OWNER), [])
    } finally {
      release.resolve(undefined)
      await pending
    }
  })

  it('does not arm a wake if thread cleanup stops the process before adoption', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = supervisor.adoptRunning.bind(supervisor)
    mock.method(supervisor, 'adoptRunning', async (...args: Parameters<typeof original>) => {
      entered.resolve(undefined)
      await release.promise
      return original(...args)
    })
    let completions = 0
    const pending = startSupervisedBackgroundProcess({
      command: 'sleep 30',
      cwd: process.cwd(),
      waitMs: 10,
      owner: OWNER,
      timeoutMs: 5000,
      completionWakeArmed: true,
      onCompletion: () => {
        completions++
      },
    })
    try {
      await entered.promise
      assert.equal(listBackgroundProcesses(OWNER).length, 1)
      assert.equal(supervisor.list(OWNER.projectId).length, 0)
      await stopSupervisedBackgroundProcessesForThread(OWNER)
      release.resolve(undefined)
      await pending
      assert.equal(hasBackgroundCompletionWake(OWNER), false)
      assert.equal(completions, 0)
      assert.deepEqual(listBackgroundProcesses(OWNER), [])
      assert.equal(supervisor.list(OWNER.projectId)[0]?.state, 'cancelled')
    } finally {
      release.resolve(undefined)
      await pending
    }
  })

  it('tracks a process through natural completion', async () => {
    let completionProcessId: string | undefined
    const info = await startSupervisedBackgroundProcess({
      command: `node -e "setTimeout(() => process.exit(0), 100)"`,
      cwd: process.cwd(),
      waitMs: 10,
      owner: OWNER,
      onCompletion: (completion) => {
        completionProcessId = completion.info.id
      },
    })
    const task = supervisor
      .list(OWNER.projectId)
      .find((candidate) => candidate.processHandleId === info.id)
    assert.ok(task)
    assert.equal(task.state, 'running')
    assert.equal(task.permissionSnapshot.executionRoot, process.cwd())
    assert.equal(task.permissionSnapshot.workspaceTargetKind, 'local')

    await waitForState(supervisor, task.taskId, 'completed')
    while (completionProcessId === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    assert.equal(supervisor.get(OWNER.projectId, task.taskId)?.resultRef?.ref, info.id)
    assert.equal(completionProcessId, info.id)
  })

  it('cancels the supervised task when the process is stopped', async () => {
    const info = await startSupervisedBackgroundProcess({
      command: 'sleep 30',
      cwd: process.cwd(),
      waitMs: 10,
      owner: OWNER,
      timeoutMs: 5000,
      completionWakeArmed: true,
    })
    const task = supervisor
      .list(OWNER.projectId)
      .find((candidate) => candidate.processHandleId === info.id)
    assert.ok(task)

    assert.equal(hasBackgroundCompletionWake(OWNER), true)
    assert.equal(await stopSupervisedBackgroundProcess(info.id, OWNER), true)
    assert.equal(hasBackgroundCompletionWake(OWNER), false)

    assert.equal(supervisor.get(OWNER.projectId, task.taskId)?.state, 'cancelled')
  })

  it('cancels supervised metadata during thread resource cleanup', async () => {
    const info = await startSupervisedBackgroundProcess({
      command: 'sleep 30',
      cwd: process.cwd(),
      waitMs: 10,
      owner: OWNER,
      timeoutMs: 5000,
      completionWakeArmed: true,
    })
    const task = supervisor
      .list(OWNER.projectId)
      .find((candidate) => candidate.processHandleId === info.id)
    assert.ok(task)

    assert.equal(hasBackgroundCompletionWake(OWNER), true)
    assert.deepEqual(await stopSupervisedBackgroundProcessesForThread(OWNER), [info.id])
    assert.equal(hasBackgroundCompletionWake(OWNER), false)

    assert.equal(supervisor.get(OWNER.projectId, task.taskId)?.state, 'cancelled')
  })

  it('retains scoped supervision after the initiating scope returns', async () => {
    const scopedRoot = join(root, 'scoped')
    const scoped = new TaskSupervisor({
      store: new FileSupervisedTaskStore({ COPSE_WORKSPACE_DIR: scopedRoot }),
    })
    await scoped.start()
    try {
      const info = await runWithBackgroundProcessSupervisor(scoped, () =>
        startSupervisedBackgroundProcess({
          command: `node -e "setTimeout(() => process.exit(0), 100)"`,
          cwd: process.cwd(),
          waitMs: 10,
          owner: OWNER,
        }),
      )
      const task = scoped
        .list(OWNER.projectId)
        .find((candidate) => candidate.processHandleId === info.id)
      assert.ok(task)
      assert.equal(
        supervisor.list(OWNER.projectId).some((candidate) => candidate.processHandleId === info.id),
        false,
      )

      await waitForState(scoped, task.taskId, 'completed')
    } finally {
      await scoped.shutdown()
    }
  })

  it('terminates a child cancelled through a scoped supervisor', async () => {
    const scopedRoot = join(root, 'scoped-cancel')
    const scoped = new TaskSupervisor({
      store: new FileSupervisedTaskStore({ COPSE_WORKSPACE_DIR: scopedRoot }),
    })
    await scoped.start()
    try {
      const info = await runWithBackgroundProcessSupervisor(scoped, () =>
        startSupervisedBackgroundProcess({
          command: 'sleep 30',
          cwd: process.cwd(),
          waitMs: 10,
          owner: OWNER,
          timeoutMs: 5000,
          completionWakeArmed: true,
        }),
      )
      const task = scoped
        .list(OWNER.projectId)
        .find((candidate) => candidate.processHandleId === info.id)
      assert.ok(task)

      assert.equal(
        await runWithBackgroundProcessSupervisor(scoped, () =>
          stopSupervisedBackgroundProcess(info.id, OWNER),
        ),
        true,
      )

      assert.equal(scoped.get(OWNER.projectId, task.taskId)?.state, 'cancelled')
      assert.equal(hasBackgroundCompletionWake(OWNER), false)
      assert.equal(
        listBackgroundProcesses(OWNER).some((process) => process.id === info.id),
        false,
      )
    } finally {
      await scoped.shutdown()
    }
  })
})
