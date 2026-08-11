import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import {
  setCiWatchScheduler,
  type ScheduleCiWatchRequest,
} from '../services/github/ci-watch-service.ts'
import { runWithThreadExecutionContext } from '../services/thread-execution-context.ts'
import { runWithActiveRunIdentity, setActiveRunTurnTreeId } from '../services/thread-models.ts'
import { waitForCiChecksTool } from './github-ci-tools.ts'

const context = {
  projectId: 'project-1',
  threadId: 'thread-1',
  projectRoot: '/project',
  root: '/project/worktree',
  checkoutMode: 'worktree' as const,
  branch: 'feature',
}

afterEach(() => {
  setCiWatchScheduler(null)
})

describe('wait_for_ci_checks', () => {
  it('registers a durable watch for the active owner and turn tree', async () => {
    const captured: ScheduleCiWatchRequest[] = []
    setCiWatchScheduler((request) => {
      captured.push(request)
      return Promise.resolve({
        watching: true,
        taskId: 'ci-watch-1',
        status: {
          prNumber: 42,
          prTitle: 'Durable watch',
          prUrl: 'https://github.com/example/repo/pull/42',
          branch: 'feature',
          headSha: 'head-1',
          overall: 'pending',
          checks: [{ name: 'test', state: 'IN_PROGRESS', bucket: 'pending' }],
          latestRunId: 100,
          latestRunUrl: 'https://github.com/example/repo/actions/runs/100',
        },
      })
    })

    const args = waitForCiChecksTool.parameters.parse({ pr_number: 42 })
    const result = await runWithThreadExecutionContext(context, () =>
      runWithActiveRunIdentity(context.threadId, () => {
        setActiveRunTurnTreeId(asTurnTreeId('tree-1'))
        return waitForCiChecksTool.execute(args, new AbortController().signal)
      }),
    )

    if (typeof result !== 'string') assert.fail('expected a text tool result')
    assert.match(result, /Durable CI watch ci-watch-1 is armed/)
    assert.match(result, /End this turn now; do not poll/)
    assert.deepEqual(captured, [
      {
        context,
        turnTreeId: 'tree-1',
        prNumber: 42,
        timeoutMs: 7_200_000,
        pollIntervalMs: 60_000,
      },
    ])
  })
})
