import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { z } from 'zod'
import { defineTool } from '@shared/types'
import { ToolRegistry, setPermissionGateForTests } from '../tool-registry.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import { getApprovalToolCallId } from '../approval-tool-call-context.ts'
import { createOpenAiHostTools } from './openai-host-tools.ts'

const context = {
  projectId: 'project',
  threadId: 'thread',
  projectRoot: '/tmp',
  root: '/tmp',
  checkoutMode: 'shared' as const,
  branch: 'feature',
}

describe('OpenAI host registry boundary', () => {
  afterEach(() => {
    setPermissionGateForTests(null)
  })
  it('advertises only curated tools and requires the owning thread', async () => {
    const registry = new ToolRegistry()
    for (const name of ['gh_pr_create', 'gh_pr_list', 'run_shell', 'write_file', 'gh_pr_merge']) {
      registry.register(
        defineTool({ name, description: name, parameters: z.object({}), execute: () => 'Done' }),
      )
    }
    assert.deepEqual(createOpenAiHostTools(registry, 'thread').definitions, [])
    const bridge = runWithThreadExecutionContext(context, () =>
      createOpenAiHostTools(registry, 'thread'),
    )
    assert.deepEqual(
      bridge.definitions.map((t) => t.name),
      ['gh_pr_create', 'gh_pr_list'],
    )
    const result = await runWithThreadExecutionContext({ ...context, threadId: 'other' }, () =>
      bridge.execute('gh_pr_list', {}, 'call', new AbortController().signal),
    )
    assert.equal(result.success, false)
  })
  it('uses the existing permission gate with call identity, and never executes a denied write', async () => {
    const registry = new ToolRegistry()
    let executed = 0
    registry.register(
      defineTool({
        name: 'gh_pr_create',
        description: 'Create',
        parameters: z.object({ title: z.string(), body: z.string(), draft: z.boolean() }),
        execute: () => {
          executed++
          return 'Done: created'
        },
      }),
    )
    let allowed = false
    let gated = 0
    setPermissionGateForTests(async () => {
      gated++
      assert.equal(getApprovalToolCallId(), 'call')
      return allowed
    })
    await runWithThreadExecutionContext(context, async () => {
      const bridge = createOpenAiHostTools(registry, 'thread')
      const args = { title: 'Title', body: 'Body', draft: true }
      assert.equal(
        (
          await bridge.execute(
            'gh_pr_create',
            { ...args, head: 'other' },
            'call',
            new AbortController().signal,
          )
        ).success,
        false,
      )
      assert.equal(gated, 0)
      assert.equal(
        (await bridge.execute('gh_pr_create', args, 'call', new AbortController().signal)).success,
        false,
      )
      assert.equal(executed, 0)
      allowed = true
      assert.equal(
        (await bridge.execute('gh_pr_create', args, 'call', new AbortController().signal)).success,
        true,
      )
      assert.equal(executed, 1)
    })
  })
})
