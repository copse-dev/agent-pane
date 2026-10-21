import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { isAgentRunReadonly } from '../agent-run-readonly.ts'
import { TaskSupervisor } from '../supervisor/task-supervisor.ts'
import { FileSupervisedTaskStore } from '../supervisor/task-store.ts'
import { createSupervisedTaskClient } from '../supervisor/task-client.ts'
import {
  createReadonlyWorkerTurn,
  READONLY_WORKER_CONCURRENCY_CLASS,
} from './readonly-worker-batch.ts'

const owner = { projectId: 'project', threadId: 'parent' }
const permissionSnapshot = {
  capturedAt: 1,
  autoRunSandboxCommands: false,
  projectSandboxEnabled: false,
}
const requests = [
  { agent: 'reader-a', prompt: 'Inspect a' },
  { agent: 'reader-b', prompt: 'Inspect b' },
]
function latch(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {
    throw new Error('Uninitialized latch')
  }
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('supervised read-only worker batches', () => {
  const supervisors: TaskSupervisor[] = []
  const roots: string[] = []
  async function setup(limit = 2): Promise<TaskSupervisor> {
    const root = await mkdtemp(join(tmpdir(), 'copse-readonly-workers-'))
    roots.push(root)
    const supervisor = new TaskSupervisor({
      store: new FileSupervisedTaskStore({ COPSE_WORKSPACE_DIR: root }),
      concurrencyClassLimits: { [READONLY_WORKER_CONCURRENCY_CLASS]: limit },
      cancellationGraceMs: 10,
    })
    supervisors.push(supervisor)
    return supervisor
  }
  afterEach(async () => {
    await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.shutdown()))
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('runs two workers concurrently, preserves submission context, and attributes reports', async () => {
    const supervisor = await setup()
    const started = latch()
    const release = latch()
    const context = new AsyncLocalStorage<string>()
    let active = 0
    const run = context.run('parent-context', () =>
      createReadonlyWorkerTurn(supervisor).run({
        owner,
        permissionSnapshot,
        requests,
        signal: new AbortController().signal,
        execute: async (request) => {
          assert.equal(context.getStore(), 'parent-context')
          assert.equal(isAgentRunReadonly(), true)
          if (++active === 2) started.resolve()
          await release.promise
          return request.prompt
        },
      }),
    )
    await started.promise
    assert.equal(supervisor.list().filter((task) => task.state === 'running').length, 2)
    release.resolve()
    const results = await run
    const visible = await createSupervisedTaskClient(supervisor, owner).list()
    assert.deepEqual(visible.tasks.map((task) => task.agentId).sort(), ['reader-a', 'reader-b'])
    assert.equal(new Set(results.map((result) => result.workerId)).size, 2)
    assert.deepEqual(
      results.map(({ agent, state, report }) => ({ agent, state, report })),
      requests.map((request) => ({
        agent: request.agent,
        state: 'completed',
        report: request.prompt,
      })),
    )
    assert.ok(
      supervisor
        .list()
        .every((task) => task.resourceBudget?.maxDurationMs === 120_000 && task.maxAttempts === 1),
    )
  })

  it('enforces the shared class cap across parents and rebinds a queued parent context', async () => {
    const supervisor = await setup()
    const context = new AsyncLocalStorage<string>()
    const firstStarted = latch()
    const release = latch()
    let started = 0
    const first = context.run('first', () =>
      createReadonlyWorkerTurn(supervisor).run({
        owner,
        permissionSnapshot,
        requests,
        signal: new AbortController().signal,
        execute: async () => {
          if (++started === 2) firstStarted.resolve()
          await release.promise
          return 'first'
        },
      }),
    )
    await firstStarted.promise
    const secondOwner = { ...owner, threadId: 'second-parent' }
    const queued = latch()
    const unsubscribe = supervisor.subscribe(() => {
      if (supervisor.list().filter((task) => task.threadId === secondOwner.threadId).length === 2)
        queued.resolve()
    })
    const second = context.run('second', () =>
      createReadonlyWorkerTurn(supervisor).run({
        owner: secondOwner,
        permissionSnapshot,
        requests,
        signal: new AbortController().signal,
        execute: async () => {
          assert.equal(context.getStore(), 'second')
          return 'second'
        },
      }),
    )
    await queued.promise
    assert.equal(supervisor.list().filter((task) => task.state === 'running').length, 2)
    assert.equal(supervisor.list().filter((task) => task.state === 'queued').length, 2)
    release.resolve()
    await Promise.all([first, second])
    unsubscribe()
  })

  it('reserves one shared turn allowance across concurrent batch calls', async () => {
    const supervisor = await setup()
    const turn = createReadonlyWorkerTurn(supervisor)
    const execute = async (): Promise<string> => 'done'
    const options = {
      owner,
      permissionSnapshot,
      requests: requests.slice(0, 1),
      signal: new AbortController().signal,
      execute,
    }
    const first = turn.run(options)
    const second = turn.run(options)
    await assert.rejects(turn.run(options), /At most two/)
    await Promise.all([first, second])
    await assert.rejects(turn.run(options), /At most two/)
  })

  it('cancels running and queued work, releases capacity and never starts queued inference', async () => {
    const supervisor = await setup(1)
    const started = latch()
    const controller = new AbortController()
    let calls = 0
    const run = createReadonlyWorkerTurn(supervisor).run({
      owner,
      permissionSnapshot,
      requests,
      signal: controller.signal,
      execute: async (_request, _id, signal) => {
        calls++
        started.resolve()
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              resolve()
            },
            { once: true },
          )
        })
        return 'late report'
      },
    })
    await started.promise
    controller.abort()
    const results = await run
    assert.equal(calls, 1)
    assert.ok(
      results.every((result) => result.state === 'cancelled' && result.report === undefined),
    )
    const next = await createReadonlyWorkerTurn(supervisor).run({
      owner,
      permissionSnapshot,
      requests: requests.slice(0, 1),
      signal: new AbortController().signal,
      execute: async () => 'next parent can run',
    })
    assert.equal(next[0]?.report, 'next parent can run')
  })

  it('lets the owner cancel one worker while a sibling completes and denies foreign cancellation', async () => {
    const supervisor = await setup()
    const started = latch()
    const run = createReadonlyWorkerTurn(supervisor).run({
      owner,
      permissionSnapshot,
      requests,
      signal: new AbortController().signal,
      execute: async (request, _id, signal) => {
        if (request.agent === 'reader-b') return 'sibling report'
        started.resolve()
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              resolve()
            },
            { once: true },
          )
        })
        return 'cancelled report must not escape'
      },
    })
    await started.promise
    const task = supervisor.list().find((entry) => entry.agentId === 'reader-a')
    assert.ok(task)
    assert.deepEqual(
      await createSupervisedTaskClient(supervisor, { ...owner, threadId: 'foreign' }).cancel(
        task.taskId,
      ),
      { task: null },
    )
    await createSupervisedTaskClient(supervisor, owner).cancel(task.taskId)
    const results = await run
    assert.equal(results[0]?.state, 'cancelled')
    assert.equal(results[0].report, undefined)
    assert.equal(results[1]?.report, 'sibling report')
  })

  it('reports failure without discarding a successful sibling or retrying inference', async () => {
    const supervisor = await setup()
    const results = await createReadonlyWorkerTurn(supervisor).run({
      owner,
      permissionSnapshot,
      requests,
      signal: new AbortController().signal,
      execute: async (request) => {
        if (request.agent === 'reader-a') throw new Error('provider unavailable')
        return 'second report'
      },
    })
    assert.equal(results[0]?.state, 'failed')
    assert.match(results[0].error ?? '', /provider unavailable/)
    assert.equal(results[1]?.report, 'second report')
    assert.ok(supervisor.list().every((task) => task.attempt === 1))
  })
})
