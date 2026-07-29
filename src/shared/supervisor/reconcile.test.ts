import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { reconcileSupervisedTasks } from './reconcile.ts'
import { parseSupervisedTaskMeta, type SupervisedTaskMeta } from './task-schema.ts'

const fix = join(process.cwd(), 'tests/fixtures/background-supervisor')

function loadMeta(name: string): SupervisedTaskMeta {
  const parsed = parseSupervisedTaskMeta(JSON.parse(readFileSync(join(fix, name), 'utf8')))
  assert.ok(parsed, `fixture ${name} must validate`)
  return parsed
}

describe('reconcileSupervisedTasks', () => {
  it('is inert when there are no tasks', () => {
    const result = reconcileSupervisedTasks({ tasks: [], now: 1 })
    assert.deepEqual(result.patches, [])
    assert.deepEqual(result.eligibleWakeTaskIds, [])
    assert.equal(result.hasActiveWork, false)
  })

  it('fails a running shell task whose process handle is dead', () => {
    const running = loadMeta('meta-running-with-handle.json')
    const now = 1700000010000
    const result = reconcileSupervisedTasks({
      tasks: [running],
      now,
      processHandles: new Map([['bg-proc-42', false]]),
    })
    assert.equal(result.patches.length, 1)
    const patch = result.patches[0]
    assert.ok(patch)
    assert.equal(patch.next.state, 'failed')
    assert.equal(patch.next.lastError, 'process handle lost on restart')
    assert.equal(patch.next.processHandleId, undefined)
    assert.equal(patch.audit.action, 'fail')
    assert.equal(result.hasActiveWork, false)
  })

  it('fails a running shell task when no handle map is provided', () => {
    const running = loadMeta('meta-running-with-handle.json')
    const result = reconcileSupervisedTasks({ tasks: [running], now: 99 })
    assert.equal(result.patches[0]?.next.state, 'failed')
  })

  it('leaves a running shell task alone when its handle is alive', () => {
    const running = loadMeta('meta-running-with-handle.json')
    const result = reconcileSupervisedTasks({
      tasks: [running],
      now: 1700000010000,
      processHandles: new Map([['bg-proc-42', true]]),
    })
    assert.deepEqual(result.patches, [])
    assert.equal(result.hasActiveWork, true)
  })

  it('demotes a handle-less running agent task to queued', () => {
    const agentRunning: SupervisedTaskMeta = {
      ...loadMeta('meta-queued.json'),
      taskId: 'task-agent-running',
      state: 'running',
      startedAt: 1700000001000,
      updatedAt: 1700000001000,
    }
    const result = reconcileSupervisedTasks({ tasks: [agentRunning], now: 1700000010000 })
    assert.equal(result.patches.length, 1)
    const patch = result.patches[0]
    assert.ok(patch)
    assert.equal(patch.next.state, 'queued')
    assert.equal(patch.audit.action, 'reconcile')
    assert.deepEqual(result.eligibleWakeTaskIds, ['task-agent-running'])
    assert.equal(result.hasActiveWork, true)
  })

  it('demotes a handle-less running agent task to waiting when wake_at is still future', () => {
    const agentRunning: SupervisedTaskMeta = {
      ...loadMeta('meta-waiting-wake-at.json'),
      taskId: 'task-agent-waiting-run',
      state: 'running',
      startedAt: 1700000001000,
    }
    const now = 1700000005000 // before wakeAt 1700003600000
    const result = reconcileSupervisedTasks({ tasks: [agentRunning], now })
    assert.equal(result.patches[0]?.next.state, 'waiting')
    assert.deepEqual(result.eligibleWakeTaskIds, [])
  })

  it('lists past wake_at waiting tasks as eligible without flipping state', () => {
    const waiting = loadMeta('meta-waiting-wake-at.json')
    const now = 1700003600001
    const result = reconcileSupervisedTasks({ tasks: [waiting], now })
    assert.deepEqual(result.patches, [])
    assert.deepEqual(result.eligibleWakeTaskIds, [waiting.taskId])
    assert.equal(result.hasActiveWork, true)
  })

  it('does not mark future wake_at as eligible', () => {
    const waiting = loadMeta('meta-waiting-wake-at.json')
    const result = reconcileSupervisedTasks({ tasks: [waiting], now: 1700000002000 })
    assert.deepEqual(result.eligibleWakeTaskIds, [])
  })

  it('leaves blocked and terminal tasks unchanged', () => {
    const blocked = loadMeta('meta-blocked.json')
    const completed = loadMeta('meta-completed.json')
    const result = reconcileSupervisedTasks({
      tasks: [blocked, completed],
      now: 1700009999999,
    })
    assert.deepEqual(result.patches, [])
    assert.deepEqual(result.eligibleWakeTaskIds, [])
    assert.equal(result.hasActiveWork, true)
  })

  it('reports hasActiveWork only when a non-terminal task remains', () => {
    const completed = loadMeta('meta-completed.json')
    const onlyDone = reconcileSupervisedTasks({ tasks: [completed], now: 1 })
    assert.equal(onlyDone.hasActiveWork, false)

    const queued = loadMeta('meta-queued.json')
    const mixed = reconcileSupervisedTasks({ tasks: [completed, queued], now: 1 })
    assert.equal(mixed.hasActiveWork, true)
    assert.deepEqual(mixed.eligibleWakeTaskIds, [queued.taskId])
  })
})
