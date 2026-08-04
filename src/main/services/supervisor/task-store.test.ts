import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import {
  parseSupervisedTaskAuditLog,
  type SupervisedTaskAuditEvent,
  type SupervisedTaskMeta,
} from '@shared/supervisor/task-schema.ts'
import { FileSupervisedTaskStore } from './task-store.ts'

function queuedTask(projectId: string, taskId: string): SupervisedTaskMeta {
  return {
    taskId,
    projectId,
    threadId: 'thread-1',
    handler: 'test',
    provenance: 'agent',
    state: 'queued',
    createdAt: 1,
    updatedAt: 1,
    trigger: { kind: 'immediate' },
    permissionSnapshot: {
      capturedAt: 1,
      autoRunSandboxCommands: true,
      projectSandboxEnabled: true,
    },
    reapproveOnWake: false,
    concurrencyClass: 'test',
    attempt: 0,
    maxAttempts: 1,
  }
}

function event(task: SupervisedTaskMeta, id: string): SupervisedTaskAuditEvent {
  return {
    v: 1,
    id,
    taskId: task.taskId,
    action: 'enqueue',
    at: task.updatedAt,
    toState: task.state,
  }
}

describe('FileSupervisedTaskStore', () => {
  it('writes atomic metadata and append-only audit events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copse-supervisor-store-'))
    const store = new FileSupervisedTaskStore({ COPSE_WORKSPACE_DIR: root })
    const queued = queuedTask('project-1', 'task-1')
    const running: SupervisedTaskMeta = {
      ...queued,
      state: 'running',
      updatedAt: 2,
      startedAt: 2,
      attempt: 1,
    }

    try {
      await store.saveTransition(queued, event(queued, 'event-1'))
      await store.saveTransition(running, {
        ...event(running, 'event-2'),
        action: 'start',
        fromState: 'queued',
      })

      assert.deepEqual(await store.get('project-1', 'task-1'), running)
      const audit = parseSupervisedTaskAuditLog(
        await readFile(join(root, 'project-1', 'tasks', 'task-1', 'audit.jsonl'), 'utf8'),
      )
      assert.deepEqual(
        audit.map((entry) => entry.id),
        ['event-1', 'event-2'],
      )
      const files = await readdir(join(root, 'project-1', 'tasks', 'task-1'))
      assert.ok(!files.some((file) => file.endsWith('.tmp')))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('isolates malformed records and remains inert when the root is absent', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'copse-supervisor-load-'))
    const root = join(parent, 'missing-at-first')
    const store = new FileSupervisedTaskStore({ COPSE_WORKSPACE_DIR: root })

    try {
      assert.deepEqual(await store.loadAll(), { tasks: [], diagnostics: [] })
      const malformedPath = join(root, 'project-1', 'tasks', 'broken', 'meta.json')
      await mkdir(dirname(malformedPath), { recursive: true })
      await writeFile(malformedPath, '{broken', 'utf8')
      const valid = queuedTask('project-1', 'valid')
      await store.saveTransition(valid, event(valid, 'valid-event'))

      const loaded = await store.loadAll()
      assert.deepEqual(loaded.tasks, [valid])
      assert.equal(loaded.diagnostics.length, 1)
      assert.match(loaded.diagnostics[0]?.reason ?? '', /malformed/)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('rejects task ids that escape the project task directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copse-supervisor-path-'))
    const store = new FileSupervisedTaskStore({ COPSE_WORKSPACE_DIR: root })
    const escaped = queuedTask('project-1', '../escaped')

    try {
      await assert.rejects(
        store.saveTransition(escaped, event(escaped, 'event-1')),
        /outside|path separators/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('compacts expired terminal tasks into queryable support summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copse-supervisor-retention-'))
    const store = new FileSupervisedTaskStore({ COPSE_WORKSPACE_DIR: root })
    const oldCompleted: SupervisedTaskMeta = {
      ...queuedTask('project-1', 'old-completed'),
      state: 'completed',
      updatedAt: 100,
      finishedAt: 100,
    }
    const recentFailed: SupervisedTaskMeta = {
      ...queuedTask('project-1', 'recent-failed'),
      state: 'failed',
      updatedAt: 900,
      finishedAt: 900,
      lastError: 'keep live',
    }
    const oldActive = queuedTask('project-1', 'old-active')

    try {
      await store.saveTransition(oldCompleted, event(oldCompleted, 'old-complete'))
      await store.saveTransition(recentFailed, event(recentFailed, 'recent-fail'))
      await store.saveTransition(oldActive, event(oldActive, 'old-active'))

      assert.equal(await store.compactTerminalTasks(500), 1)
      assert.equal(await store.compactTerminalTasks(500), 0)
      assert.equal(await store.get('project-1', 'old-completed'), null)
      assert.deepEqual((await store.loadAll()).tasks.map((task) => task.taskId).sort(), [
        'old-active',
        'recent-failed',
      ])
      assert.deepEqual(await store.loadTaskArchive('project-1'), [
        {
          v: 1,
          taskId: 'old-completed',
          projectId: 'project-1',
          threadId: 'thread-1',
          handler: 'test',
          provenance: 'agent',
          state: 'completed',
          createdAt: 1,
          updatedAt: 100,
          finishedAt: 100,
          attempt: 0,
        },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
