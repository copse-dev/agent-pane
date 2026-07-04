import assert from 'node:assert/strict'
import { at } from '@shared/array-utils.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  createLongTask,
  loadLongTasks,
  setStepDone,
  setLongTaskRootForTest,
  taskProgress,
} from './long-task-tracker.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'

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
})
