import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { SupervisedTaskMeta } from '@shared/supervisor/task-schema.ts'
import { FileSupervisedTaskStore } from '../supervisor/task-store.ts'
import { TaskSupervisor, type EnqueueSupervisedTaskInput } from '../supervisor/task-supervisor.ts'
import {
  HostTaskSupervisor,
  type HostTaskCall,
  type HostTaskCallResult,
} from './host-task-supervisor.ts'

const input: EnqueueSupervisedTaskInput = {
  projectId: 'p1',
  threadId: 't1',
  handler: 'shell_process',
  provenance: 'agent',
  trigger: { kind: 'immediate' },
  permissionSnapshot: {
    capturedAt: 1,
    autoRunSandboxCommands: true,
    projectSandboxEnabled: false,
    executionRoot: '/tmp',
    workspaceTargetKind: 'local',
  },
  reapproveOnWake: true,
  concurrencyClass: 'shell_process',
  maxAttempts: 1,
}

describe('HostTaskSupervisor', () => {
  let root: string
  let app: TaskSupervisor
  let calls: HostTaskCall['op'][]
  let host: HostTaskSupervisor

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'copse-host-tasks-'))
    // The app's own supervisor, which keeps the records.
    app = new TaskSupervisor({ store: new FileSupervisedTaskStore({ COPSE_WORKSPACE_DIR: root }) })
    app.registerExternalCanceller('shell_process', () => undefined)
    calls = []
    host = new HostTaskSupervisor(async (call): Promise<HostTaskCallResult> => {
      calls.push(call.op)
      switch (call.op) {
        case 'adopt':
          return { task: await app.adoptRunning(call.input, call.processHandle) }
        case 'complete':
          return { task: await app.completeExternal(call.projectId, call.taskId, call.resultRef) }
        case 'fail':
          return { task: await app.failExternal(call.projectId, call.taskId, call.reason) }
        case 'cancel':
          return { task: await app.cancel(call.projectId, call.taskId) }
      }
    })
  })

  afterEach(async () => {
    await app.shutdown()
    rmSync(root, { recursive: true, force: true })
  })

  it("keeps a host command's task in the app's supervisor, and reads its copy", async () => {
    const adopted = await host.adoptRunning(input, 'bg-1')
    assert.equal(app.get('p1', adopted.taskId)?.state, 'running', 'the app holds the record')
    assert.equal(host.get('p1', adopted.taskId)?.processHandleId, 'bg-1')
    assert.ok(host.runs(adopted))
    const done = await host.completeExternal('p1', adopted.taskId, { kind: 'handler', ref: 'bg-1' })
    assert.equal(done?.state, 'completed')
    assert.equal(host.get('p1', adopted.taskId)?.state, 'completed')
    assert.deepEqual(
      host.list('p1').map((task) => task.taskId),
      [adopted.taskId],
    )
    assert.deepEqual(calls, ['adopt', 'complete'])
  })

  it('stops its process when the app cancels the task, and ignores tasks it does not run', async () => {
    const stopped: string[] = []
    host.registerExternalCanceller('shell_process', (task) => {
      stopped.push(task.processHandleId ?? '')
    })
    const adopted = await host.adoptRunning(input, 'bg-2')
    const cancelled = await app.cancel('p1', adopted.taskId)
    assert.ok(cancelled)
    host.changed(cancelled)
    host.changed(cancelled)
    await Promise.resolve()
    assert.deepEqual(stopped, ['bg-2'], 'stopped once')
    const other: SupervisedTaskMeta = { ...cancelled, taskId: 'not-ours' }
    host.changed(other)
    assert.equal(host.get('p1', 'not-ours'), null)
  })

  it('fails a call the app refused', async () => {
    const refusing = new HostTaskSupervisor(() => Promise.resolve({ error: 'no app' }))
    await assert.rejects(refusing.adoptRunning(input, 'bg-3'), /no app/)
  })
})
