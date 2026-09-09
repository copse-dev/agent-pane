import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { FileSupervisedTaskStore } from './task-store.ts'
import { TaskSupervisor, type EnqueueSupervisedTaskInput } from './task-supervisor.ts'

const input: EnqueueSupervisedTaskInput & { contentHash: string } = {
  projectId: 'project-1',
  threadId: 'stable-thread',
  handler: 'prepare',
  trigger: { kind: 'immediate' },
  provenance: 'system',
  maxAttempts: 3,
  permissionSnapshot: {
    capturedAt: 1,
    autoRunSandboxCommands: false,
    projectSandboxEnabled: false,
  },
  concurrencyClass: 'test',
  reapproveOnWake: true,
  contentHash: 'stable-content',
}

async function fixture(t: TestContext): Promise<{
  root: string
  store: FileSupervisedTaskStore
  create(): TaskSupervisor
}> {
  const root = await mkdtemp(join(tmpdir(), 'copse-enqueue-once-'))
  const store = new FileSupervisedTaskStore({ COPSE_WORKSPACE_DIR: root })
  const supervisors: TaskSupervisor[] = []
  const create = (): TaskSupervisor => {
    const supervisor = new TaskSupervisor({ store, onDiagnostic: (): void => undefined })
    supervisors.push(supervisor)
    return supervisor
  }
  t.after(async () => {
    for (const supervisor of supervisors) await supervisor.shutdown()
    await rm(root, { recursive: true, force: true })
  })
  return { root, store, create }
}

describe('idempotent supervisor admission', () => {
  it('shares one task across concurrent admissions and rejects a changed binding', async (t) => {
    const f = await fixture(t)
    const supervisor = f.create()
    let executions = 0
    supervisor.registerHandler('prepare', () => {
      executions++
      return Promise.resolve({})
    })
    const tasks = await Promise.all(
      Array.from({ length: 8 }, () => supervisor.enqueueOnce('stable-task', input)),
    )
    await t.waitFor(() => {
      assert.equal(supervisor.get(input.projectId, 'stable-task')?.state, 'completed')
    })
    assert.equal(executions, 1)
    assert.equal(new Set(tasks.map((task) => task.taskId)).size, 1)
    for (const changed of [
      { contentHash: 'changed' },
      { threadId: 'changed' },
      { handler: 'changed' },
    ]) {
      await assert.rejects(
        supervisor.enqueueOnce('stable-task', { ...input, ...changed }),
        /different content/,
      )
    }
    await assert.rejects(supervisor.enqueueOnce('../escape', input), /safe identity/)
    const audit = await readFile(
      join(f.root, input.projectId, 'tasks/stable-task/audit.jsonl'),
      'utf8',
    )
    assert.equal(audit.split('\n').filter((line) => line.includes('"action":"enqueue"')).length, 1)
  })

  it('recovers archived identity without executing or recreating live metadata', async (t) => {
    const f = await fixture(t)
    const first = f.create()
    first.registerHandler('prepare', () => Promise.resolve({}))
    await first.enqueueOnce('stable-task', input)
    await t.waitFor(() => {
      assert.equal(first.get(input.projectId, 'stable-task')?.state, 'completed')
    })
    await first.shutdown()
    assert.equal(await f.store.compactTerminalTasks(Number.MAX_SAFE_INTEGER), 1)
    const second = f.create()
    second.registerHandler('prepare', () => {
      assert.fail('Archived work must not execute')
    })
    const recovered = await second.enqueueOnce('stable-task', input)
    assert.equal(recovered.state, 'completed')
    assert.equal(recovered.contentHash, input.contentHash)
    assert.deepEqual(second.list(), [])
    assert.equal(await f.store.get(input.projectId, 'stable-task'), null)
    await assert.rejects(
      second.enqueueOnce('stable-task', { ...input, contentHash: 'changed' }),
      /different content/,
    )
  })

  for (const location of ['missing-meta', 'corrupt-meta', 'corrupt-archive', 'wrong-identity']) {
    it(`refuses to overwrite an existing ${location} task slot`, async (t) => {
      const f = await fixture(t)
      const taskDir = join(f.root, input.projectId, 'tasks/stable-task')
      const archiveDir = join(f.root, input.projectId, 'task-history')
      if (location === 'corrupt-archive') {
        await mkdir(archiveDir, { recursive: true })
        await writeFile(join(archiveDir, 'stable-task.json'), '{broken')
      } else {
        await mkdir(taskDir, { recursive: true })
        if (location !== 'missing-meta')
          await writeFile(
            join(taskDir, 'meta.json'),
            location === 'wrong-identity'
              ? JSON.stringify({
                  ...input,
                  taskId: 'other-task',
                  state: 'queued',
                  createdAt: 1,
                  updatedAt: 1,
                  attempt: 0,
                })
              : '{broken',
          )
      }
      const supervisor = f.create()
      supervisor.registerHandler('prepare', () => {
        assert.fail('Corrupt work must not execute')
      })
      await assert.rejects(supervisor.enqueueOnce('stable-task', input))
      assert.deepEqual(supervisor.list(), [])
    })
  }
})
