import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { runWithActiveRunIdentity } from '../active-run-identity.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import { threadExecutionContextStorage } from '../thread-execution-context-store.ts'
import { recordClassifierCall } from './classifier-call-log.ts'
import { getThreadClassifierUse } from './classifier-use-report.ts'
import { readDecisionLog } from './decision-log-store.ts'

const WINDOW_PROJECT = 'window-project'

describe('recordClassifierCall project attribution', () => {
  let root = ''
  let previousRoot: string | undefined
  let previousProject: unknown

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-classifier-call-log-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
    previousProject = storageGet('activeProjectId')
    // The window's selection: no call below may be recorded on it.
    storageSet('activeProjectId', WINDOW_PROJECT)
  })

  afterEach(() => {
    storageSet('activeProjectId', previousProject)
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  function call(engine: string): Parameters<typeof recordClassifierCall>[0] {
    return {
      subject: 'shell-scope',
      engine,
      verdictLabel: 'sandbox',
      latencyMs: 1,
    }
  }

  it("records concurrent turns in two projects on each turn's own project", async () => {
    const turn = (projectId: string, threadId: string): Promise<void> =>
      threadExecutionContextStorage.run(
        {
          projectId,
          threadId,
          projectRoot: root,
          root,
          checkoutMode: 'shared',
          branch: null,
        },
        () =>
          runWithActiveRunIdentity(threadId, async () => {
            await new Promise((resolve) => setTimeout(resolve, 5))
            recordClassifierCall(call(projectId))
          }),
      )
    await Promise.all([turn('project-a', 'thread-a'), turn('project-b', 'thread-b')])

    for (const { projectId, threadId } of [
      { projectId: 'project-a', threadId: 'thread-a' },
      { projectId: 'project-b', threadId: 'thread-b' },
    ]) {
      const use = await getThreadClassifierUse(projectId, threadId)
      assert.equal(use.calls, 1)
      assert.equal(use.rows[0]?.engine, projectId)
    }
    assert.deepEqual(await readDecisionLog(WINDOW_PROJECT), [])
  })

  it('drops a run without its own turn instead of using the active project', async () => {
    runWithActiveRunIdentity('bare-run-thread', () => {
      recordClassifierCall(call('bare'))
    })
    // A turn for another thread does not lend its project either.
    threadExecutionContextStorage.run(
      {
        projectId: 'project-a',
        threadId: 'thread-a',
        projectRoot: root,
        root,
        checkoutMode: 'shared',
        branch: null,
      },
      () => {
        recordClassifierCall({ ...call('foreign'), threadId: 'foreign-thread' })
      },
    )
    assert.deepEqual(await readDecisionLog(WINDOW_PROJECT), [])
    assert.deepEqual(await readDecisionLog('project-a'), [])
  })
})
