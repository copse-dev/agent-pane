import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import type { StoredThreadPlan } from '@copse/thread-store/plan-schema.ts'
import { planCriteria } from '@copse/thread-store/plan-schema.ts'
import {
  runWithThreadPlan,
  getRunPlan,
  planToolBlockReason,
  threadPlanInstructions,
} from './thread-plan-context.ts'
import { ToolRegistry, setPermissionGateForTests } from './tool-registry.ts'
import { ensureToolPermitted } from './security/permission-gate.ts'
import { createCommandHookRunner } from './hooks/command-hook-runner.ts'

const draft: StoredThreadPlan = {
  meta: {
    planId: '7d474bd7-e39c-4181-8503-1cbe822c0cda',
    threadId: 'thread-1',
    title: 'Fix login',
    status: 'draft',
    currentRevision: 2,
    createdAt: 1,
    updatedAt: 2,
  },
  body: '# Goal\nFix login\n# Constraints\nKeep sessions\n# Scope\nLogin only\n# Definition of done\n- Login works\n- Regression test passes',
  contentHash: 'hash',
  comments: [],
  approval: null,
  completion: null,
}
describe('thread plan capability boundary', () => {
  it('denies shell, all MCP, child agents, background and future tools before permission hooks', async () => {
    const registry = new ToolRegistry()
    let gated = 0
    let executed = 0
    setPermissionGateForTests(async () => {
      gated++
      return true
    })
    const denied = [
      'run_shell',
      'run_background',
      'write_file',
      'git_commit',
      'mcp__readonly__read',
      'task',
      'explore',
      'delegate_step',
      'update_todos',
      'new_future_tool',
      'report_plan_completion',
    ]
    for (const name of denied)
      registry.register({
        name,
        description: name,
        parameters: z.object({}),
        execute: async () => {
          executed++
          return 'ran'
        },
      })
    try {
      await runWithThreadPlan(draft, async () => {
        for (const name of denied) {
          const result = await registry.execute(name, {}, new AbortController().signal)
          assert.ok(typeof result === 'string')
          assert.match(result, /unavailable/)
          assert.equal(await ensureToolPermitted({ toolName: name, args: {} }), false)
        }
        for (const name of ['read_file', 'ask_user', 'update_thread_plan'])
          assert.equal(planToolBlockReason(name), null)
      })
      assert.equal(gated, 0)
      assert.equal(executed, 0)
      assert.equal(planToolBlockReason('run_shell'), null)
    } finally {
      setPermissionGateForTests(null)
    }
  })
  it('keeps concurrent thread plans isolated and includes revision-specific feedback', async () => {
    const withFeedback = {
      ...draft,
      comments: [
        { id: 'c1', revision: 1, body: 'Check expiry', createdAt: 1, anchor: { start: 0, end: 6 } },
      ],
    }
    await Promise.all([
      runWithThreadPlan(withFeedback, async () => {
        await Promise.resolve()
        assert.match(threadPlanInstructions(), /Check expiry/)
        assert.match(threadPlanInstructions(), /revision 2/)
        assert.ok(planToolBlockReason('run_shell'))
      }),
      runWithThreadPlan(null, async () => {
        await Promise.resolve()
        assert.equal(getRunPlan(), null)
        assert.equal(threadPlanInstructions(), '')
        assert.equal(planToolBlockReason('run_shell'), null)
      }),
    ])
  })
  it('blocks even fail-open command hooks at the runner without spawning', async () => {
    const runner = runWithThreadPlan(draft, () => createCommandHookRunner())
    // Nonexistent command would fail if spawned. A planning denial is an intentional
    // policy outcome, not a process failure subject to fail-open configuration.
    const result = await runner.run(
      {
        id: 'test-hook',
        event: 'beforeSubmitPrompt',
        executor: 'command',
        dialect: 'cursor',
        command: 'copse-command-that-must-never-execute',
        onFailure: 'open',
      },
      { prompt: 'hello' },
      {},
    )
    assert.equal(result.failed, false)
    assert.equal(result.outcome?.decision, 'deny')
    assert.match(result.outcome.agentMessage ?? '', /draft planning/)
  })
  it('numbers only definition-of-done bullets, with checkbox and ordered-list support', () => {
    assert.deepEqual(
      planCriteria(
        '# Goal\n- Not a criterion\n# Definition of done\n- [ ] Login works\n2. Tests pass\n# Notes\n- Excluded',
      ),
      [
        { id: 'criterion-1', label: 'Login works' },
        { id: 'criterion-2', label: 'Tests pass' },
      ],
    )
  })
})
