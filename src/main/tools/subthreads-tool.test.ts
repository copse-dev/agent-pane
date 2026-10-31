import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ThreadPromptCommand } from '@shared/thread-prompt.ts'
import { normalizeToolExecuteResult } from '@shared/types'
import { createSubthreadsTool } from './subthreads-tool.ts'
import { canDispatchSubthread } from '../services/thread-prompts.ts'
import {
  createThread,
  getProjectThread,
  updateMeta,
  appendMessage,
} from '../services/thread-store.ts'
import { runWithActiveRunIdentity } from '../services/active-run-identity.ts'
import { threadExecutionContextStorage } from '../services/thread-execution-context-store.ts'
import { runWithApprovalHandler } from '../services/approval.ts'
import { setSetting } from '../services/storage/settings.ts'
import { hasThreadAccess, revokeThreadAccess } from '../services/security/thread-access.ts'
import { z } from 'zod'
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js'
import { safeJsonParse, decodeWithSchema } from '@shared/safe-json.ts'

describe('subthread orchestration', () => {
  let root: string
  let previous: string | undefined
  let tool: ReturnType<typeof createSubthreadsTool>
  let sent: Omit<ThreadPromptCommand, 'id' | 'expiresAt'>[]
  const signal = new AbortController().signal
  const start = {
    action: 'start',
    key: 'build',
    title: 'Check build',
    prompt: 'Inspect the build and report.',
  } as const
  function run(
    args: Parameters<ReturnType<typeof createSubthreadsTool>['execute']>[0],
    owner = 'parent',
    projectId = 'project',
  ): Promise<string> {
    return runWithActiveRunIdentity(owner, () =>
      threadExecutionContextStorage.run(
        {
          projectId,
          threadId: owner,
          projectRoot: '/repo',
          root: '/repo',
          checkoutMode: 'shared',
          branch: null,
        },
        async () => normalizeToolExecuteResult(await tool.execute(args, signal)).result,
      ),
    )
  }
  function id(result: string): string {
    const parsed = safeJsonParse(result, decodeWithSchema(z.object({ thread_id: z.string() })))
    assert.ok(parsed)
    return parsed.thread_id
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-subthreads-'))
    previous = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = root
    await setSetting('threadSubthreadAccess', [])
    await setSetting('threadSubthreadOwners', [])
    sent = []
    tool = createSubthreadsTool(async (command) => {
      sent.push(command)
      return { ok: true, queued: false }
    })
    for (const projectId of ['project', 'other-project']) {
      for (const owner of ['parent', 'other']) {
        await createThread(projectId, {
          id: owner,
          title: owner,
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: 1,
          updatedAt: 1,
        })
      }
    }
  })
  afterEach(async () => {
    await setSetting('threadSubthreadAccess', [])
    await setSetting('threadSubthreadOwners', [])
    if (previous === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previous
    await rm(root, { recursive: true, force: true })
  })

  it('one approval starts multiple children, reads and sends, without granting unrelated access', async () => {
    let prompts = 0
    await runWithApprovalHandler(
      async (request) => {
        assert.equal(request.title, 'Allow subthread orchestration?')
        prompts++
        return { approved: true, remember: false }
      },
      async () => {
        const childId = id(await run(start))
        const otherId = id(await run({ ...start, key: 'tests' }))
        assert.notEqual(childId, otherId)
        assert.match(await run({ action: 'list' }), /Check build/)
        assert.match(await run({ action: 'read', thread_id: childId }), /Check build/)
        assert.match(
          await run({ action: 'send', thread_id: childId, prompt: 'Report progress.' }),
          /"ok":true/,
        )
        assert.equal(sent.length, 3)
        assert.ok(sent.every((command) => command.requireWorktree))
        assert.equal((await getProjectThread('project', childId))?.followUpOf, undefined)
        assert.equal(hasThreadAccess('parent', 'read'), false)
        assert.equal(hasThreadAccess('parent', 'send'), false)
        assert.equal(hasThreadAccess(childId, 'orchestrate'), false)
      },
    )
    assert.equal(prompts, 1)
  })

  it('uses an object schema accepted by MCP', () => {
    const schema = z.toJSONSchema(tool.parameters)
    ToolSchema.parse({ name: tool.name, description: tool.description, inputSchema: schema })
    assert.equal(schema.type, 'object')
    assert.equal(Object.hasOwn(schema, 'oneOf'), false)
  })

  it('bounds live children and lifetime starts, replaces archived keys and forbids nesting', async () => {
    await setSetting('threadSubthreadAccess', ['parent'])
    const first = id(await run(start))
    await run({ ...start, key: 'second' })
    assert.match(await run({ ...start, key: 'third' }), /two live children/)
    assert.match(await run(start, first), /cannot orchestrate nested/)
    for (let index = 0; index < 2; index++) {
      const current = await getProjectThread('project', id(await run(start)))
      assert.ok(current)
      await updateMeta('project', current.id, { archivedAt: Date.now() })
      const replacement = id(await run(start))
      assert.notEqual(replacement, current.id)
      assert.match(await run(start, current.id), /cannot orchestrate nested/)
    }
    const current = await getProjectThread('project', id(await run(start)))
    assert.ok(current)
    await updateMeta('project', current.id, { archivedAt: Date.now() })
    assert.match(await run(start), /four child starts/)
    assert.equal(sent.length, 4)
  })

  it('returns capped text without reasoning, tool payloads or inline image data', async () => {
    await setSetting('threadSubthreadAccess', ['parent'])
    const childId = id(await run(start))
    const child = await getProjectThread('project', childId)
    assert.ok(child)
    for (let index = 0; index < 100; index++) {
      await appendMessage('project', childId, {
        id: String(index),
        role: 'assistant',
        content: 'data:image/png;base64,SECRET ' + 'x'.repeat(5000),
        createdAt: 1,
        toolCalls: [],
        reasoning: 'PRIVATE_REASONING',
      })
    }
    const result = await run({ action: 'read', thread_id: childId, offset: 0, limit: 100 })
    assert.ok(Buffer.byteLength(result) < 26_000)
    assert.doesNotMatch(result, /PRIVATE_REASONING|data:image|SECRET/)
    assert.match(result, /image omitted/)
    assert.ok(sent.every((command) => command.authorizingAccess === 'orchestrate'))
  })

  it('rechecks ownership, archive state and revocation before queued dispatch', async () => {
    await setSetting('threadSubthreadAccess', ['parent'])
    const childId = id(await run(start))
    assert.equal(await canDispatchSubthread('project', 'parent', childId), true)
    assert.equal(await canDispatchSubthread('other-project', 'parent', childId), false)
    assert.equal(await canDispatchSubthread('project', 'other', childId), false)
    await revokeThreadAccess('parent', 'orchestrate')
    assert.equal(await canDispatchSubthread('project', 'parent', childId), false)
    await setSetting('threadSubthreadAccess', ['parent'])
    const child = await getProjectThread('project', childId)
    assert.ok(child)
    await updateMeta('project', child.id, { archivedAt: 1 })
    assert.equal(await canDispatchSubthread('project', 'parent', childId), false)
  })

  it('concurrent retries converge on one child and one prompt', async () => {
    await setSetting('threadSubthreadAccess', ['parent'])
    const results = await Promise.all([run(start), run(start)])
    assert.equal(id(results[0]), id(results[1]))
    assert.equal(sent.length, 1)
    assert.match(results[1], /"existing":true/)
  })

  it('denial creates no children and no model work', async () => {
    await runWithApprovalHandler(
      async () => ({ approved: false, remember: false }),
      async () => {
        assert.match(await run(start), /not granted/)
      },
    )
    assert.deepEqual(sent, [])
    await setSetting('threadSubthreadAccess', ['parent'])
    assert.equal(await run({ action: 'list' }), '[]')
  })

  it('another parent, another project and a forged parent link cannot claim a child', async () => {
    await setSetting('threadSubthreadAccess', ['parent', 'other'])
    const childId = id(await run(start))
    const unrelated = await getProjectThread('project', 'other')
    assert.ok(unrelated)
    await createThread('project', {
      ...unrelated,
      id: 'forged',
      followUpOf: { parentThreadId: 'parent' },
    })
    assert.match(await run({ action: 'read', thread_id: 'forged' }), /not one of your subthreads/)
    await runWithApprovalHandler(
      async () => {
        assert.fail('invalid destinations must not prompt')
      },
      async () => {
        for (const action of ['read', 'send'] as const) {
          const args = { action, thread_id: childId, prompt: 'Continue.' }
          assert.match(await run(args, 'other'), /not one of your subthreads/)
          assert.match(await run(args, 'parent', 'other-project'), /not one of your subthreads/)
          assert.match(await run({ ...args, thread_id: 'other' }), /not one of your subthreads/)
        }
      },
    )
    assert.equal(sent.length, 1)
  })

  it('revocation blocks further operations when renewed consent is declined', async () => {
    await setSetting('threadSubthreadAccess', ['parent'])
    const childId = id(await run(start))
    await revokeThreadAccess('parent', 'orchestrate')
    await runWithApprovalHandler(
      async () => ({ approved: false, remember: false }),
      async () => {
        assert.match(await run({ action: 'read', thread_id: childId }), /not granted/)
        assert.match(
          await run({ action: 'send', thread_id: childId, prompt: 'Continue.' }),
          /not granted/,
        )
        assert.match(await run({ ...start, key: 'another' }), /not granted/)
      },
    )
    assert.equal(sent.length, 1)
  })
})
