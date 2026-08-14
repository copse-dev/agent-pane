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

/** Run a tool action as `threadId`, with the same context shape a turn has. */
function asThread(
  threadId: string,
  args: Parameters<typeof trackLongTaskTool.execute>[0],
): ReturnType<typeof trackLongTaskTool.execute> {
  return runWithThreadExecutionContext(
    {
      projectId: 'project-1',
      threadId,
      projectRoot: '/project',
      root: '/project',
      checkoutMode: 'shared',
      branch: 'main',
    },
    () =>
      runWithActiveRunIdentity(threadId, () =>
        trackLongTaskTool.execute(args, new AbortController().signal),
      ),
  )
}

async function textResult(
  threadId: string,
  args: Parameters<typeof trackLongTaskTool.execute>[0],
): Promise<string> {
  const result = await asThread(threadId, args)
  if (typeof result !== 'string') assert.fail('expected a text tool result')
  return result
}

describe('track_long_task list scoping', () => {
  let root: string
  let restoreWorkspace: () => void

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'long-task-scope-'))
    setLongTaskRootForTest(root)
    restoreWorkspace = setWorkspaceRootForTest('/project')
  })

  afterEach(() => {
    setLongTaskRootForTest(null)
    restoreWorkspace()
    rmSync(root, { recursive: true, force: true })
  })

  it("lists only the calling thread's own tasks", async () => {
    await textResult('thread-a', {
      action: 'create',
      title: 'Read access sandbox warning',
      goal: 'grants prompt',
      steps: ['trace the gate'],
    })
    await textResult('thread-b', {
      action: 'create',
      title: 'ACP ZDR annotations',
      goal: 'zdr surfaced',
      steps: ['extract ZDR fields'],
    })

    const listedByA = await textResult('thread-a', { action: 'list' })

    assert.match(listedByA, /Read access sandbox warning/)
    assert.doesNotMatch(listedByA, /ACP ZDR annotations/)
  })

  it("reports other threads' tasks as a count rather than a checklist", async () => {
    await textResult('thread-b', {
      action: 'create',
      title: 'ACP ZDR annotations',
      goal: 'zdr surfaced',
      steps: ['extract ZDR fields'],
    })

    const listedByA = await textResult('thread-a', { action: 'list' })

    assert.match(listedByA, /No long tasks tracked for this thread/)
    assert.match(listedByA, /1 other long task in this workspace belongs to other threads/)
    // The step is what a context-less turn would pick up; the count is not.
    assert.doesNotMatch(listedByA, /extract ZDR fields/)
  })

  it('shows every task, labelled by owner, under the workspace scope', async () => {
    await textResult('thread-a', {
      action: 'create',
      title: 'Mine',
      goal: 'g',
      steps: ['s'],
    })
    await textResult('thread-b', {
      action: 'create',
      title: 'Theirs',
      goal: 'g',
      steps: ['s'],
    })

    const listed = await textResult('thread-a', { action: 'list', scope: 'workspace' })

    assert.match(listed, /\[t1\] \[this thread\] Mine/)
    assert.match(listed, /\[t2\] \[another thread\] Theirs/)
  })

  it("treats a task written before owners were recorded as nobody's to resume", async () => {
    // Written directly, the way the store looked before tasks carried a threadId.
    createLongTask({ title: 'Legacy', goal: 'g', steps: ['s'] }, '/project')

    const listed = await textResult('thread-a', { action: 'list' })

    assert.match(listed, /No long tasks tracked for this thread/)
    assert.match(listed, /1 other long task/)
  })

  it('still resolves an explicit task id from another thread', async () => {
    await textResult('thread-b', {
      action: 'create',
      title: 'Theirs',
      goal: 'g',
      steps: ['s'],
    })

    // The supervised wake path resolves tasks by id, so id lookups stay
    // workspace-wide even though listing does not.
    const status = await textResult('thread-a', { action: 'status', taskId: 't1' })

    assert.match(status, /Theirs/)
  })
})

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
