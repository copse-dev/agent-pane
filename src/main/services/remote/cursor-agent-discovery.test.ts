import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import type { Thread } from '@shared/types'
import {
  buildExternalCursorAgentStub,
  collectLinkedCursorAgentIds,
  cursorAgentMatchesRepository,
  discoverExternalCursorAgents,
  parseCursorAgentDetail,
  parseCursorAgentListPage,
  type CursorAgentDetail,
} from './cursor-agent-discovery.ts'

function detail(
  overrides: Partial<CursorAgentDetail> & Pick<CursorAgentDetail, 'id'>,
): CursorAgentDetail {
  return {
    id: overrides.id,
    name: overrides.name ?? 'Add README',
    status: overrides.status ?? 'ACTIVE',
    url: overrides.url ?? `https://cursor.com/agents/${overrides.id}`,
    createdAt: overrides.createdAt ?? '2026-04-13T18:30:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-13T18:45:00.000Z',
    latestRunId: overrides.latestRunId ?? 'run-1',
    repos: overrides.repos ?? [{ url: 'https://github.com/acme/project', startingRef: 'main' }],
  }
}

describe('parseCursorAgentListPage', () => {
  it('keeps durable identity rows and drops incomplete ones', () => {
    const page = parseCursorAgentListPage({
      items: [
        {
          id: 'bc-1',
          name: 'One',
          status: 'ACTIVE',
          url: 'https://cursor.com/agents/bc-1',
          createdAt: '2026-04-13T18:30:00.000Z',
          latestRunId: 'run-1',
        },
        { id: 'bc-bad', name: 'Missing fields' },
      ],
      nextCursor: 'bc-2',
    })
    assert.equal(page.items.length, 1)
    assert.equal(page.items[0]?.id, 'bc-1')
    assert.equal(page.nextCursor, 'bc-2')
  })
})

describe('cursorAgentMatchesRepository', () => {
  it('matches owner/repo ignoring scheme and .git suffix', () => {
    const agent = detail({
      id: 'bc-1',
      repos: [{ url: 'https://github.com/Acme/project.git' }],
    })
    assert.equal(cursorAgentMatchesRepository(agent, 'https://github.com/acme/project'), true)
    assert.equal(cursorAgentMatchesRepository(agent, 'https://github.com/acme/other'), false)
  })
})

describe('collectLinkedCursorAgentIds', () => {
  it('collects only Cursor-linked agent ids', () => {
    const threads = [
      {
        remoteAgentLink: {
          provider: 'cursor',
          agentId: 'bc-1',
          createdAt: 1,
        },
      },
      {
        remoteAgentLink: {
          provider: 'anthropic',
          agentId: 'ma-1',
          createdAt: 1,
        },
      },
      {},
    ] as Thread[]
    assert.deepEqual([...collectLinkedCursorAgentIds(threads)], ['bc-1'])
  })
})

describe('buildExternalCursorAgentStub', () => {
  it('builds an idle linked stub with Cursor model + import notice', () => {
    const agent = detail({ id: 'bc-1', name: 'Fix auth' })
    const thread = buildExternalCursorAgentStub({
      agent,
      repositoryUrl: 'https://github.com/acme/project',
      now: 1_700_000_000_000,
      threadId: 'thread-1',
      messageId: 'msg-1',
    })
    assert.equal(thread.id, 'thread-1')
    assert.equal(thread.title, 'Fix auth')
    assert.equal(thread.status, 'idle')
    assert.equal(thread.model, 'remote-agent:cursor')
    const link = thread.remoteAgentLink
    assert.ok(link)
    assert.equal(link.agentId, 'bc-1')
    assert.equal(link.repo, 'acme/project')
    assert.equal(link.branch, 'main')
    assert.equal(link.runId, 'run-1')
    assert.equal(thread.messages.length, 1)
    const notice = thread.messages[0]
    assert.ok(notice)
    assert.match(notice.content, /Imported Cursor cloud agent/)
    assert.match(notice.content, /cursor\.com\/agents\/bc-1/)
  })
})

describe('discoverExternalCursorAgents', () => {
  it('imports matching ACTIVE agents, skips linked / wrong-repo / inactive', async () => {
    const created: Thread[] = []
    const seeded: Array<{ threadId: string; agentId: string; url?: string }> = []
    const ids = ['thread-a', 'msg-a', 'thread-b', 'msg-b']
    let idIdx = 0

    const fetchImpl = mock.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/v1/agents?')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'bc-linked',
                name: 'Already local',
                status: 'ACTIVE',
                url: 'https://cursor.com/agents/bc-linked',
                createdAt: '2026-04-13T18:00:00.000Z',
              },
              {
                id: 'bc-match',
                name: 'Outside run',
                status: 'ACTIVE',
                url: 'https://cursor.com/agents/bc-match',
                createdAt: '2026-04-13T18:30:00.000Z',
                latestRunId: 'run-match',
              },
              {
                id: 'bc-other-repo',
                name: 'Other repo',
                status: 'ACTIVE',
                url: 'https://cursor.com/agents/bc-other-repo',
                createdAt: '2026-04-13T18:40:00.000Z',
              },
              {
                id: 'bc-archived',
                name: 'Archived',
                status: 'ARCHIVED',
                url: 'https://cursor.com/agents/bc-archived',
                createdAt: '2026-04-13T17:00:00.000Z',
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/v1/agents/bc-match')) {
        return new Response(
          JSON.stringify(
            detail({
              id: 'bc-match',
              name: 'Outside run',
              latestRunId: 'run-match',
            }),
          ),
          { status: 200 },
        )
      }
      if (url.endsWith('/v1/agents/bc-other-repo')) {
        return new Response(
          JSON.stringify(
            detail({
              id: 'bc-other-repo',
              name: 'Other repo',
              repos: [{ url: 'https://github.com/acme/elsewhere' }],
            }),
          ),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const prevKey = process.env['CURSOR_API_KEY']
    process.env['CURSOR_API_KEY'] = 'test-key'
    try {
      const result = await discoverExternalCursorAgents({
        projectId: 'proj-1',
        repositoryUrl: 'https://github.com/acme/project',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        loadThreadsImpl: async () => [
          {
            id: 'existing',
            title: 'Existing',
            status: 'idle',
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: 1,
            updatedAt: 1,
            remoteAgentLink: {
              provider: 'cursor',
              agentId: 'bc-linked',
              createdAt: 1,
            },
          },
        ],
        createThreadImpl: async (_projectId, thread) => {
          created.push(thread)
        },
        seedSessionImpl: (input) => {
          seeded.push({
            threadId: input.threadId,
            agentId: input.agentId,
            ...(input.url ? { url: input.url } : {}),
          })
        },
        newId: () => {
          const next = ids[idIdx]
          idIdx += 1
          if (!next) throw new Error('ran out of test ids')
          return next
        },
        now: () => 1_700_000_000_000,
      })

      assert.deepEqual(result, {
        imported: [
          {
            threadId: 'thread-a',
            agentId: 'bc-match',
            title: 'Outside run',
            url: 'https://cursor.com/agents/bc-match',
          },
        ],
        scanned: 4,
        skippedLinked: 1,
        skippedWrongRepo: 1,
        skippedInactive: 1,
      })
      assert.equal(created.length, 1)
      const stub = created[0]
      assert.ok(stub)
      assert.equal(stub.id, 'thread-a')
      assert.equal(stub.remoteAgentLink?.agentId, 'bc-match')
      assert.deepEqual(seeded, [
        {
          threadId: 'thread-a',
          agentId: 'bc-match',
          url: 'https://cursor.com/agents/bc-match',
        },
      ])
      // List + one GET per ACTIVE unlinked candidate (match + other-repo).
      assert.equal(fetchImpl.mock.callCount(), 3)
    } finally {
      if (prevKey === undefined) delete process.env['CURSOR_API_KEY']
      else process.env['CURSOR_API_KEY'] = prevKey
    }
  })

  it('fails fast without a GitHub-backed project', async () => {
    await assert.rejects(
      discoverExternalCursorAgents({
        projectId: 'proj-1',
        repositoryUrl: null,
        fetchImpl: () => {
          throw new Error('unexpected network call')
        },
      }),
      /GitHub remote/,
    )
  })
})

describe('parseCursorAgentDetail', () => {
  it('requires identity fields and preserves repos', () => {
    const parsed = parseCursorAgentDetail({
      id: 'bc-1',
      name: 'X',
      status: 'ACTIVE',
      url: 'https://cursor.com/agents/bc-1',
      createdAt: '2026-04-13T18:30:00.000Z',
      repos: [{ url: 'https://github.com/acme/project', startingRef: 'main' }, { url: 1 }],
    })
    assert.ok(parsed)
    assert.deepEqual(parsed.repos, [
      { url: 'https://github.com/acme/project', startingRef: 'main' },
    ])
  })
})
