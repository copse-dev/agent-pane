import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createLongTask, setLongTaskRootForTest } from '../services/storage/long-task-tracker.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import { runWithThreadExecutionContext } from '../services/thread-execution-context.ts'
import { runWithActiveRunIdentity, setActiveRunTurnTreeId } from '../services/thread-models.ts'
import {
  setLongTaskWakeScheduler,
  type ScheduleLongTaskWakeRequest,
} from '../services/supervisor/long-task-wake.ts'
import { trackLongTaskTool } from './long-task-tool.ts'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'

describe('track_long_task continue', () => {
  let root: string
  let restoreWorkspace: () => void

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'long-task-tool-'))
    setLongTaskRootForTest(root)
    restoreWorkspace = setWorkspaceRootForTest('/project')
  })

  afterEach(() => {
    setLongTaskWakeScheduler(null)
    setLongTaskRootForTest(null)
    restoreWorkspace()
    rmSync(root, { recursive: true, force: true })
  })

  it('schedules one wake bound to the active owner and turn tree', async () => {
    const task = createLongTask({ title: 'Backlog', goal: 'green', steps: ['fix'] })
    const captured: ScheduleLongTaskWakeRequest[] = []
    setLongTaskWakeScheduler((request) => {
      captured.push(request)
      return Promise.resolve({ taskId: 'supervised-1', wakeAt: 2_000 })
    })

    const result = await runWithThreadExecutionContext(
      {
        projectId: 'project-1',
        threadId: 'thread-1',
        projectRoot: '/project',
        root: '/project',
        checkoutMode: 'shared',
        branch: 'main',
      },
      () =>
        runWithActiveRunIdentity('thread-1', () => {
          setActiveRunTurnTreeId(asTurnTreeId('tree-1'))
          return trackLongTaskTool.execute(
            { action: 'continue', taskId: task.id, delaySeconds: 2 },
            new AbortController().signal,
          )
        }),
    )

    if (typeof result !== 'string') assert.fail('expected a text tool result')
    assert.match(result, /Scheduled one supervised continuation/)
    const scheduled = captured[0]
    assert.ok(scheduled)
    assert.equal(scheduled.context.projectId, 'project-1')
    assert.equal(scheduled.turnTreeId, 'tree-1')
    assert.equal(scheduled.delayMs, 2_000)
  })
})
