import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { TaskSupervisor } from '../supervisor/task-supervisor.ts'
import { FileSupervisedTaskStore } from '../supervisor/task-store.ts'
import { stopAllBackgroundProcesses } from './background-process.ts'
import {
  installBackgroundProcessSupervisor,
  runWithBackgroundProcessSupervisor,
  startSupervisedBackgroundProcess,
  stopSupervisedBackgroundProcess,
  stopSupervisedBackgroundProcessesForThread,
} from './supervised-background-process.ts'

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
  let root: string
  let supervisor: TaskSupervisor
  let dispose: () => void

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'copse-supervised-background-'))
    supervisor = new TaskSupervisor({
      store: new FileSupervisedTaskStore({ COPSE_WORKSPACE_DIR: root }),
    })
    dispose = installBackgroundProcessSupervisor(supervisor)
    await supervisor.start()
  })

  afterEach(async () => {
    stopAllBackgroundProcesses()
    await supervisor.shutdown()
    dispose()
    rmSync(root, { recursive: true, force: true })
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
    })
    const task = supervisor
      .list(OWNER.projectId)
      .find((candidate) => candidate.processHandleId === info.id)
    assert.ok(task)

    assert.equal(await stopSupervisedBackgroundProcess(info.id, OWNER), true)

    assert.equal(supervisor.get(OWNER.projectId, task.taskId)?.state, 'cancelled')
  })

  it('cancels supervised metadata during thread resource cleanup', async () => {
    const info = await startSupervisedBackgroundProcess({
      command: 'sleep 30',
      cwd: process.cwd(),
      waitMs: 10,
      owner: OWNER,
    })
    const task = supervisor
      .list(OWNER.projectId)
      .find((candidate) => candidate.processHandleId === info.id)
    assert.ok(task)

    assert.deepEqual(await stopSupervisedBackgroundProcessesForThread(OWNER), [info.id])

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
})
