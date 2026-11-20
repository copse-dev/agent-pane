import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createThread,
  deleteProjectThread,
  recordThreadCommitProduction,
  recordThreadPrProduction,
  updateMeta,
} from '../services/thread-store.ts'
import { runSerialized } from '@copse/thread-store/write-queue.ts'
import {
  commitProductionSchema,
  prProductionSchema,
  prRefSchema,
} from '@copse/thread-store/thread-pr-relations.ts'
import { runWithApprovalHandler } from '../services/approval.ts'
import { runWithActiveRunIdentity } from '../services/active-run-identity.ts'
import { setSetting } from '../services/storage/settings.ts'
import { listThreadsTool, sendThreadPromptTool } from './thread-tools.ts'
import {
  createAutomationBudget,
  withAutomationBudget,
} from '../services/automations/automation-budget.ts'
import { storageRemoveFile } from '../services/storage/user-data-files.ts'
import { storageGet, storageSet } from '../services/storage/storage.ts'
import { hasThreadAccess, revokeThreadAccess } from '../services/security/thread-access.ts'
import { normalizeToolExecuteResult } from '@shared/types'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'

const listedThreadsSchema = z.array(z.object({ id: z.string(), projectId: z.string() }))
const stateRowsSchema = z.array(
  z.object({
    id: z.string(),
    state: z.object({
      basis: z.literal('stored-metadata'),
      status: z.enum(['idle', 'running', 'error']),
      updatedAt: z.number(),
      brief: z.object({ text: z.string(), truncated: z.boolean() }).nullable(),
      plan: z.object({
        items: z.array(
          z.object({
            content: z.string(),
            status: z.string(),
            truncated: z.boolean(),
          }),
        ),
        total: z.number(),
        omitted: z.number(),
      }),
      checkout: z.object({
        basis: z.literal('recorded-not-verified'),
        mode: z.enum(['shared', 'worktree', 'deferred']),
        branch: z.string().nullable(),
        path: z.string().nullable(),
        baseCommit: z.string().nullable(),
        retiredAt: z.number().nullable(),
      }),
      productions: z.object({
        commits: z.array(commitProductionSchema),
        totalCommits: z.number(),
        pullRequests: z.array(prProductionSchema),
        totalPullRequests: z.number(),
      }),
    }),
  }),
)

describe('conversation tools', () => {
  let root: string
  let previous: string | undefined
  let projects: unknown
  const signal = new AbortController().signal
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-thread-tools-'))
    previous = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = root
    projects = storageGet('projects')
    storageSet('projects', [{ id: 'thread-tools-project', name: 'Project', path: '/repo' }])
    await createThread('thread-tools-project', {
      id: 'thread-tools-destination',
      title: 'Investigate build failures',
      status: 'idle',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 1,
    })
  })
  afterEach(async () => {
    await setSetting('threadReadAccess', [])
    await setSetting('threadSendAccess', [])
    storageSet('projects', projects)
    if (previous === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previous
    await rm(root, { recursive: true, force: true })
  })

  it('withholds catalog and saved state when read access is declined', async () => {
    for (const include_state of [false, true]) {
      const result = await runWithApprovalHandler(
        async () => ({ approved: false, remember: false }),
        () =>
          runWithActiveRunIdentity('thread-tools-source', () =>
            listThreadsTool.execute({ include_state }, signal),
          ),
      )
      assert.doesNotMatch(normalizeToolExecuteResult(result).result, /Investigate build failures/)
    }
  })

  it('searches the catalog after read approval without granting sending', async () => {
    const result = await runWithApprovalHandler(
      async () => ({ approved: true, remember: false }),
      () =>
        runWithActiveRunIdentity('thread-tools-source', () =>
          listThreadsTool.execute({ query: 'build' }, signal),
        ),
    )
    assert.match(normalizeToolExecuteResult(result).result, /Investigate build failures/)
    assert.equal(hasThreadAccess('thread-tools-source', 'send'), false)
    assert.doesNotMatch(normalizeToolExecuteResult(result).result, /"state":/)
    assert.equal(listThreadsTool.provenance, 'external')
  })

  it('returns bounded saved state and exact native receipts without replaying payloads', async () => {
    await createThread('thread-tools-project', {
      id: 'worker',
      title: 'Repair parser',
      status: 'error',
      workingBrief: 'B'.repeat(1100),
      messages: [
        {
          id: 'message',
          role: 'assistant',
          content: 'TRANSCRIPT_PAYLOAD '.repeat(2000),
          toolCalls: [],
          createdAt: 1,
        },
      ],
      todos: Array.from({ length: 12 }, (_, index) => ({
        id: index === 0 ? 'I'.repeat(100_000) : `todo-${String(index)}`,
        content: 'P'.repeat(260),
        status: 'pending',
        check: { kind: 'shell', command: 'CHECK_PAYLOAD' },
      })),
      gitBranch: 'codex/parser',
      worktree: {
        path: '/recorded/worker',
        branch: 'codex/parser',
        baseBranch: 'main',
        baseCommit: 'a'.repeat(40),
        createdAt: 1,
        seededFromDirtyProject: false,
      },
      prRefs: [
        {
          owner: 'acme',
          repo: 'widgets',
          number: 999,
          url: 'https://github.com/acme/widgets/pull/999',
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 20,
    })
    for (let index = 0; index < 4; index++) {
      await recordThreadCommitProduction('thread-tools-project', 'worker', {
        repository: 'github.com/acme/widgets',
        sha: String(index).repeat(40),
        eventId: `commit-${String(index)}`,
        source: 'git-commit',
        createdAt: index,
      })
      await recordThreadPrProduction('thread-tools-project', 'worker', {
        pr: {
          owner: 'acme',
          repo: 'widgets',
          number: index + 1,
          url: `https://github.com/acme/widgets/pull/${String(index + 1)}`,
        },
        eventId: `pr-${String(index)}`,
        source: 'pr-create',
        createdAt: index,
      })
    }
    await setSetting('threadReadAccess', ['thread-tools-source'])
    const output = await runWithActiveRunIdentity(
      'thread-tools-source',
      async () =>
        normalizeToolExecuteResult(
          await listThreadsTool.execute({ query: 'Repair parser', include_state: true }, signal),
        ).result,
    )
    const rows = safeJsonParse(output, decodeWithSchema(stateRowsSchema))
    assert.ok(rows)
    const state = rows[0]?.state
    assert.ok(state)
    assert.equal(state.status, 'error')
    assert.equal(state.updatedAt, 20)
    assert.deepEqual(state.brief, { text: 'B'.repeat(1000), truncated: true })
    assert.equal(state.plan.items.length, 10)
    assert.equal(state.plan.total, 12)
    assert.equal(state.plan.omitted, 2)
    assert.equal(state.plan.items[0]?.content, 'P'.repeat(240))
    assert.equal(state.plan.items[0].truncated, true)
    assert.deepEqual(state.checkout, {
      basis: 'recorded-not-verified',
      mode: 'worktree',
      branch: 'codex/parser',
      path: '/recorded/worker',
      baseCommit: 'a'.repeat(40),
      retiredAt: null,
    })
    assert.equal(state.productions.totalCommits, 4)
    assert.equal(state.productions.totalPullRequests, 4)
    assert.deepEqual(
      state.productions.commits.map((receipt) => receipt.sha),
      ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)],
    )
    assert.deepEqual(
      state.productions.pullRequests.map((receipt) => receipt.pr.number),
      [2, 3, 4],
    )
    assert.equal(state.productions.commits[0]?.eventId, 'commit-1')
    assert.doesNotMatch(JSON.stringify(state), /999|TRANSCRIPT_PAYLOAD|CHECK_PAYLOAD|I{100}/)
    assert.equal(hasThreadAccess('thread-tools-source', 'send'), false)
    assert.ok(output.length < 7000, `compact state returned ${String(output.length)} characters`)
  })

  it('reports absent facts as unknown and refreshes saved state after metadata writes', async () => {
    await setSetting('threadReadAccess', ['thread-tools-source'])
    await runWithActiveRunIdentity('thread-tools-source', async () => {
      const read = async (): Promise<z.infer<typeof stateRowsSchema>> => {
        const output = normalizeToolExecuteResult(
          await listThreadsTool.execute({ include_state: true }, signal),
        ).result
        const rows = safeJsonParse(output, decodeWithSchema(stateRowsSchema))
        assert.ok(rows)
        return rows
      }
      const first = (await read())[0]?.state
      assert.ok(first)
      assert.equal(first.brief, null)
      assert.deepEqual(first.plan, { items: [], total: 0, omitted: 0 })
      assert.equal(first.checkout.mode, 'shared')
      assert.equal(first.checkout.path, null)
      await updateMeta('thread-tools-project', 'thread-tools-destination', {
        status: 'running',
        updatedAt: 30,
        workingBrief: 'Verify parser without changing it',
        deferredWorktree: { baseBranch: 'main', requestedAt: 2 },
      })
      const next = (await read())[0]?.state
      assert.ok(next)
      assert.equal(next.status, 'running')
      assert.equal(next.updatedAt, 30)
      assert.deepEqual(next.brief, { text: 'Verify parser without changing it', truncated: false })
      assert.equal(next.checkout.mode, 'deferred')
      assert.equal(next.checkout.path, null)
    })
  })

  it('bounds compact discovery despite long titles and hundreds of mentioned pull requests', async () => {
    const title = `Review campaign progress ${'and verify current ownership '.repeat(150)}`
    const prRefs = Array.from({ length: 300 }, (_, index) => ({
      owner: 'copse-dev',
      repo: 'agent-pane',
      number: index + 1,
      url: `https://github.com/copse-dev/agent-pane/pull/${String(index + 1)}`,
    }))
    for (let index = 0; index < 20; index++) {
      await createThread('thread-tools-project', {
        id: `campaign-${String(index).padStart(2, '0')}`,
        title,
        workingBrief:
          'Verify the assigned fix and report its current head and acceptance evidence.',
        status: 'idle',
        messages: [],
        todos: [{ id: 'verify', content: 'Check the assigned fix', status: 'pending' }],
        prRefs,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: 1,
        updatedAt: index + 2,
      })
    }
    await setSetting('threadReadAccess', ['thread-tools-source'])
    await runWithActiveRunIdentity('thread-tools-source', async () => {
      const catalog = normalizeToolExecuteResult(
        await listThreadsTool.execute({ limit: 20 }, signal),
      ).result
      const catalogRows = safeJsonParse(
        catalog,
        decodeWithSchema(
          z.array(
            z.object({
              id: z.string(),
              title: z.string(),
              prRefs: z.array(prRefSchema),
              spinePath: z.string(),
            }),
          ),
        ),
      )
      assert.ok(catalogRows)
      assert.equal(catalogRows.length, 20)
      assert.equal(catalogRows[0]?.title, title)
      assert.equal(catalogRows[0].prRefs.length, 300)
      assert.doesNotMatch(catalog, /"titleTruncated":/)

      const compact = normalizeToolExecuteResult(
        await listThreadsTool.execute({ include_state: true, limit: 20 }, signal),
      ).result
      assert.ok(
        compact.length < 25_000,
        `compact discovery returned ${String(compact.length)} characters`,
      )
      const compactRows = safeJsonParse(
        compact,
        decodeWithSchema(
          z.array(
            z.strictObject({
              projectId: z.literal('thread-tools-project'),
              id: z.string(),
              title: z.string(),
              titleTruncated: z.boolean(),
              spinePath: z.string(),
              state: stateRowsSchema.element.shape.state,
            }),
          ),
        ),
      )
      assert.ok(compactRows)
      assert.equal(compactRows.length, 20)
      assert.equal(compactRows[0]?.title, title.slice(0, 240))
      assert.equal(compactRows[0].titleTruncated, true)
      assert.equal(compactRows[0].id, catalogRows[0].id)
      assert.equal(compactRows[0].spinePath, catalogRows[0].spinePath)
      assert.equal(compactRows[0].state.productions.totalPullRequests, 0)
    })
  })

  it('preserves complete emoji at title, brief and plan truncation boundaries', async () => {
    await setSetting('threadReadAccess', ['thread-tools-source'])
    for (const crossesBoundary of [true, false]) {
      const padding = crossesBoundary ? 1 : 2
      const titlePrefix = 'T'.repeat(240 - padding)
      const briefPrefix = 'B'.repeat(1000 - padding)
      const planPrefix = 'P'.repeat(240 - padding)
      await updateMeta('thread-tools-project', 'thread-tools-destination', {
        title: `${titlePrefix}🪵`,
        workingBrief: `${briefPrefix}🌳`,
        todos: [{ id: 'verify', content: `${planPrefix}🌱`, status: 'in_progress' }],
      })
      const output = await runWithActiveRunIdentity(
        'thread-tools-source',
        async () =>
          normalizeToolExecuteResult(await listThreadsTool.execute({ include_state: true }, signal))
            .result,
      )
      const rows = safeJsonParse(output, decodeWithSchema(stateRowsSchema))
      assert.ok(rows)
      const state = rows[0]?.state
      assert.ok(state)
      assert.deepEqual(state.brief, {
        text: crossesBoundary ? briefPrefix : `${briefPrefix}🌳`,
        truncated: crossesBoundary,
      })
      assert.deepEqual(state.plan.items, [
        {
          content: crossesBoundary ? planPrefix : `${planPrefix}🌱`,
          status: 'in_progress',
          truncated: crossesBoundary,
        },
      ])
      const titledRows = safeJsonParse(
        output,
        decodeWithSchema(
          z.array(
            z.object({
              title: z.string(),
              titleTruncated: z.boolean(),
            }),
          ),
        ),
      )
      assert.deepEqual(titledRows, [
        {
          title: crossesBoundary ? titlePrefix : `${titlePrefix}🪵`,
          titleTruncated: crossesBoundary,
        },
      ])
    }
  })

  it('rejects oversized state pages instead of silently skipping rows for the next offset', async () => {
    await runWithApprovalHandler(
      async () => {
        assert.fail('invalid pagination must not ask for permission')
      },
      () =>
        runWithActiveRunIdentity('thread-tools-source', async () => {
          const result = await listThreadsTool.execute({ include_state: true, limit: 21 }, signal)
          assert.match(normalizeToolExecuteResult(result).result, /at most 20/)
        }),
    )
  })

  it('keeps unfinished work visible after more than ten completed plan items', async () => {
    await updateMeta('thread-tools-project', 'thread-tools-destination', {
      todos: [
        ...Array.from({ length: 12 }, (_, index) => ({
          id: `done-${String(index)}`,
          content: `Earlier work ${String(index)}`,
          status: 'completed' as const,
        })),
        { id: 'current', content: 'Verify the parser fix', status: 'in_progress' },
        { id: 'waiting', content: 'Await independent verification', status: 'pending' },
        { id: 'cancelled', content: 'Abandoned approach', status: 'cancelled' },
      ],
    })
    await setSetting('threadReadAccess', ['thread-tools-source'])
    const result = await runWithActiveRunIdentity('thread-tools-source', () =>
      listThreadsTool.execute({ include_state: true }, signal),
    )
    const rows = safeJsonParse(
      normalizeToolExecuteResult(result).result,
      decodeWithSchema(stateRowsSchema),
    )
    assert.ok(rows)
    const plan = rows[0]?.state.plan
    assert.ok(plan)
    assert.equal(plan.total, 15)
    assert.equal(plan.omitted, 5)
    assert.deepEqual(
      plan.items.map((item) => item.content),
      [
        'Verify the parser fix',
        'Await independent verification',
        'Earlier work 0',
        'Earlier work 1',
        'Earlier work 2',
        'Earlier work 3',
        'Earlier work 4',
        'Earlier work 5',
        'Earlier work 6',
        'Earlier work 7',
      ],
    )
    assert.equal(plan.items[0]?.status, 'in_progress')
    assert.equal(plan.items[1]?.status, 'pending')
  })

  for (const interruption of ['revoke', 'cancel'] as const) {
    it(`withholds saved state when ${interruption} occurs while a store read waits`, async () => {
      await setSetting('threadReadAccess', ['thread-tools-source'])
      const controller = new AbortController()
      const entered = Promise.withResolvers<undefined>()
      const released = Promise.withResolvers<undefined>()
      const blocked = runSerialized('thread-store:thread-tools-project', async () => {
        entered.resolve(undefined)
        await released.promise
      })
      await entered.promise
      const reading = runWithActiveRunIdentity('thread-tools-source', () =>
        listThreadsTool.execute({ include_state: true }, controller.signal),
      )
      if (interruption === 'revoke') await revokeThreadAccess('thread-tools-source', 'read')
      else controller.abort()
      released.resolve(undefined)
      await blocked
      const result = normalizeToolExecuteResult(await reading).result
      assert.doesNotMatch(result, /Investigate build failures|"state":/)
    })
  }

  it('withholds a project removed after its catalog read was queued', async () => {
    await setSetting('threadReadAccess', ['thread-tools-source'])
    const entered = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    const blocked = runSerialized('thread-store:thread-tools-project', async () => {
      entered.resolve(undefined)
      await released.promise
    })
    await entered.promise
    const reading = runWithActiveRunIdentity('thread-tools-source', () =>
      listThreadsTool.execute({ include_state: true }, signal),
    )
    // The granted access check yields once. The list operation then captures
    // projects and queues the catalog before this second queue operation.
    await Promise.resolve()
    const removed = runSerialized('thread-store:thread-tools-project', () => {
      storageSet('projects', [])
    })
    released.resolve(undefined)
    await blocked
    await removed
    assert.equal(normalizeToolExecuteResult(await reading).result, '[]')
  })

  for (const removal of ['delete', 'archive'] as const) {
    it(`omits a selected worker if ${removal} runs between catalog and metadata reads`, async () => {
      await setSetting('threadReadAccess', ['thread-tools-source'])
      const entered = Promise.withResolvers<undefined>()
      const released = Promise.withResolvers<undefined>()
      const blocked = runSerialized('thread-store:thread-tools-project', async () => {
        entered.resolve(undefined)
        await released.promise
      })
      await entered.promise
      const reading = runWithActiveRunIdentity('thread-tools-source', () =>
        listThreadsTool.execute({ include_state: true }, signal),
      )
      // Granted ensureThreadAccess yields once, then enqueues the catalog read.
      await Promise.resolve()
      const removed =
        removal === 'delete'
          ? deleteProjectThread('thread-tools-project', 'thread-tools-destination')
          : updateMeta('thread-tools-project', 'thread-tools-destination', { archivedAt: 30 })
      released.resolve(undefined)
      await blocked
      await removed
      assert.equal(normalizeToolExecuteResult(await reading).result, '[]')
    })
  }

  it('pages globally recent matches across projects, excluding the caller before slicing', async () => {
    storageSet('projects', [
      { id: 'thread-tools-project', name: 'First', path: '/first' },
      { id: 'thread-tools-second', name: 'Second', path: '/second' },
    ])
    for (const [projectId, id, updatedAt, title] of [
      ['thread-tools-project', 'thread-tools-source', 100, 'Build caller'],
      ['thread-tools-project', 'first-recent', 30, 'Build first'],
      ['thread-tools-second', 'second-recent', 40, 'Build second'],
      ['thread-tools-second', 'unmatched', 90, 'Unrelated conversation'],
    ] as const) {
      await createThread(projectId, {
        id,
        title,
        updatedAt,
        createdAt: 1,
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      })
    }
    await setSetting('threadReadAccess', ['thread-tools-source'])
    await runWithActiveRunIdentity('thread-tools-source', async () => {
      const first = normalizeToolExecuteResult(
        await listThreadsTool.execute({ query: 'build', limit: 1 }, signal),
      ).result
      assert.deepEqual(safeJsonParse(first, decodeWithSchema(listedThreadsSchema)), [
        { id: 'second-recent', projectId: 'thread-tools-second' },
      ])
      const second = normalizeToolExecuteResult(
        await listThreadsTool.execute({ query: 'build', limit: 1, offset: 1 }, signal),
      ).result
      assert.deepEqual(safeJsonParse(second, decodeWithSchema(listedThreadsSchema)), [
        { id: 'first-recent', projectId: 'thread-tools-project' },
      ])
      const scoped = normalizeToolExecuteResult(
        await listThreadsTool.execute(
          { query: 'build', project_id: 'thread-tools-project', limit: 1 },
          signal,
        ),
      ).result
      assert.deepEqual(safeJsonParse(scoped, decodeWithSchema(listedThreadsSchema)), [
        { id: 'first-recent', projectId: 'thread-tools-project' },
      ])
      const beyond = normalizeToolExecuteResult(
        await listThreadsTool.execute({ offset: 100 }, signal),
      ).result
      assert.equal(beyond, '[]')
    })
  })

  it('bounds the default result and keeps tied timestamps stable across pages', async () => {
    for (let index = 0; index < 51; index++) {
      await createThread('thread-tools-project', {
        id: `recent-${String(index).padStart(2, '0')}`,
        title: 'Recent conversation',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: 1,
        updatedAt: 10,
      })
    }
    await setSetting('threadReadAccess', ['thread-tools-source'])
    await runWithActiveRunIdentity('thread-tools-source', async () => {
      const result = normalizeToolExecuteResult(await listThreadsTool.execute({}, signal)).result
      const hits = safeJsonParse(result, decodeWithSchema(listedThreadsSchema))
      assert.ok(hits)
      assert.equal(hits.length, 50)
      assert.equal(hits[0]?.id, 'recent-00')
      assert.equal(hits[49]?.id, 'recent-49')
      const next = normalizeToolExecuteResult(
        await listThreadsTool.execute({ offset: 50, limit: 1 }, signal),
      ).result
      assert.deepEqual(safeJsonParse(next, decodeWithSchema(listedThreadsSchema)), [
        { id: 'recent-50', projectId: 'thread-tools-project' },
      ])
      const compact = normalizeToolExecuteResult(
        await listThreadsTool.execute({ include_state: true }, signal),
      ).result
      const compactRows = safeJsonParse(compact, decodeWithSchema(stateRowsSchema))
      assert.ok(compactRows)
      assert.equal(compactRows.length, 10)
      assert.equal(compactRows[9]?.id, 'recent-09')
      const nextCompact = normalizeToolExecuteResult(
        await listThreadsTool.execute({ include_state: true, offset: 10, limit: 1 }, signal),
      ).result
      assert.deepEqual(safeJsonParse(nextCompact, decodeWithSchema(listedThreadsSchema)), [
        { id: 'recent-10', projectId: 'thread-tools-project' },
      ])
    })
  })

  it('refuses a budgeted cross-thread prompt before asking for a sending grant', async () => {
    await createAutomationBudget('thread-tools-project', 'thread-tools-source', 10)
    try {
      await assert.rejects(
        runWithApprovalHandler(
          async () => {
            assert.fail('Unsupported budgeted delegation must not ask for a grant')
          },
          () =>
            withAutomationBudget('thread-tools-project', 'thread-tools-source', () =>
              runWithActiveRunIdentity('thread-tools-source', async () => {
                await sendThreadPromptTool.execute(
                  {
                    project_id: 'thread-tools-project',
                    thread_id: 'thread-tools-destination',
                    prompt: 'Check the build',
                  },
                  signal,
                )
              }),
            ),
        ),
        /separate worker threads/,
      )
    } finally {
      await storageRemoveFile('automation-budgets/thread-tools-project/thread-tools-source.json')
    }
  })

  it('asks separately to send and leaves the destination untouched on denial', async () => {
    await setSetting('threadReadAccess', ['thread-tools-source'])
    let title = ''
    const result = await runWithApprovalHandler(
      async (request) => {
        title = request.title
        return { approved: false, remember: false }
      },
      () =>
        runWithActiveRunIdentity('thread-tools-source', () =>
          sendThreadPromptTool.execute(
            {
              project_id: 'thread-tools-project',
              thread_id: 'thread-tools-destination',
              prompt: 'Check the build',
            },
            signal,
          ),
        ),
    )
    assert.equal(title, 'Send prompts to your other threads?')
    assert.match(normalizeToolExecuteResult(result).result, /not granted/)
    assert.equal(hasThreadAccess('thread-tools-source', 'send'), false)
  })

  it('does not request permission for self-targeted or missing destinations', async () => {
    await runWithApprovalHandler(
      async () => {
        assert.fail('should not prompt for an invalid destination')
      },
      () =>
        runWithActiveRunIdentity('thread-tools-destination', async () => {
          for (const thread_id of ['thread-tools-destination', 'missing']) {
            const result = await sendThreadPromptTool.execute(
              { project_id: 'thread-tools-project', thread_id, prompt: 'Check the build' },
              signal,
            )
            assert.match(normalizeToolExecuteResult(result).result, /different|unavailable/)
          }
        }),
    )
  })

  it('rechecks a destination deleted while send permission is pending', async () => {
    const result = await runWithApprovalHandler(
      async () => {
        await deleteProjectThread('thread-tools-project', 'thread-tools-destination')
        return { approved: true, remember: false }
      },
      () =>
        runWithActiveRunIdentity('thread-tools-source', () =>
          sendThreadPromptTool.execute(
            {
              project_id: 'thread-tools-project',
              thread_id: 'thread-tools-destination',
              prompt: 'Check the build',
            },
            signal,
          ),
        ),
    )
    assert.match(normalizeToolExecuteResult(result).result, /unavailable/)
  })
})
