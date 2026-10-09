import assert from 'node:assert/strict'
import { at } from '@shared/array-utils.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  createLongTask,
  loadLongTasks,
  loadLongTasksForScope,
  setStepDone,
  setLongTaskRootForTest,
  taskProgress,
} from './long-task-tracker.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { storageSet } from './storage.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'

describe('long-task-tracker', () => {
  let root: string
  let restoreWorkspace: () => void

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'long-tasks-'))
    setLongTaskRootForTest(root)
    restoreWorkspace = setWorkspaceRootForTest('/home/dev/my-project')
  })

  afterEach(() => {
    setLongTaskRootForTest(null)
    restoreWorkspace()
    rmSync(root, { recursive: true, force: true })
  })

  it('creates a task with a numbered, not-done checklist', () => {
    const task = createLongTask({
      title: 'Clear lint backlog',
      goal: 'lint count to zero',
      steps: ['fix file A', 'fix file B'],
    })
    assert.equal(task.id, 't1')
    assert.equal(task.steps.length, 2)
    assert.equal(at(task.steps, 0).id, 's1')
    assert.equal(at(task.steps, 0).done, false)
  })

  it('reports progress and the next step', () => {
    const task = createLongTask({ title: 'T', goal: 'g', steps: ['a', 'b'] })
    assert.deepEqual(taskProgress(task), { done: 0, total: 2, complete: false, nextStep: 'a' })
  })

  it('checks off steps and reaches the terminal complete state', () => {
    const task = createLongTask({ title: 'T', goal: 'g', steps: ['a', 'b'] })
    setStepDone(task.id, 's1', true)
    const afterOne = at(loadLongTasks(), 0)
    assert.deepEqual(taskProgress(afterOne), { done: 1, total: 2, complete: false, nextStep: 'b' })
    const done = setStepDone(task.id, 's2', true)
    assert.ok(done)
    assert.equal(taskProgress(done).complete, true)
    assert.equal(taskProgress(done).nextStep, null)
  })

  it('persists across loads and reports unknown ids', () => {
    createLongTask({ title: 'Persisted', goal: 'g', steps: ['x'] })
    assert.equal(at(loadLongTasks(), 0).title, 'Persisted')
    assert.equal(setStepDone('t999', 's1', true), null)
    assert.equal(setStepDone('t1', 's999', true), null)
  })

  it('loads by an explicit project scope when another workspace is active', () => {
    createLongTask({ title: 'Original project', goal: 'g', steps: ['x'] })
    const restoreOther = setWorkspaceRootForTest('/home/dev/other-project')
    try {
      assert.deepEqual(loadLongTasks(), [])
      const scope = { projectId: null, root: '/home/dev/my-project' }
      assert.equal(at(loadLongTasksForScope(scope), 0).title, 'Original project')
    } finally {
      restoreOther()
    }
  })

  describe('with two persisted projects', () => {
    beforeEach(() => {
      storageSet('projects', [
        { id: 'project-a', path: '/repos/alpha', name: 'alpha' },
        { id: 'project-b', path: '/repos/beta', name: 'beta' },
      ])
      // The user has switched to B while a thread in A is still running.
      storageSet('activeProjectId', 'project-b')
    })

    afterEach(() => {
      storageSet('projects', [])
      storageSet('activeProjectId', null)
    })

    it("a turn in a non-active project reads and writes that project's tasks", () => {
      const inProjectA = <T>(fn: () => T): T =>
        runWithThreadExecutionContext(
          {
            projectId: 'project-a',
            threadId: 'thread-a',
            projectRoot: '/repos/alpha',
            root: '/repos/alpha',
            checkoutMode: 'shared',
            branch: null,
          },
          fn,
        )

      const task = inProjectA(() =>
        createLongTask({ title: 'Alpha work', goal: 'g', steps: ['x'] }),
      )
      inProjectA(() => setStepDone(task.id, 's1', true))

      assert.deepEqual(loadLongTasks(), [], 'the active project B sees none of it')
      const inA = inProjectA(() => loadLongTasks())
      assert.equal(at(inA, 0).title, 'Alpha work')
      assert.equal(taskProgress(at(inA, 0)).complete, true)
      const scopeA = { projectId: 'project-a', root: '/repos/alpha' }
      assert.equal(at(loadLongTasksForScope(scopeA), 0).title, 'Alpha work')
    })
  })
})
