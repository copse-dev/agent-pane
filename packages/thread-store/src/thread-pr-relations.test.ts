import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Thread } from './thread-types.ts'
import { ThreadPrRelationshipIndex, type PrProduction } from './thread-pr-relations.ts'
import {
  createThread,
  recordThreadPrProduction,
  recordThreadCommitProduction,
  recordThreadPrRefs,
  lookupPrThreadRelationships,
  lookupThreadPrRelationships,
  lookupCommitThreadProductions,
  updateMeta,
  saveProjectThread,
  deleteProjectThread,
  getThreadMeta,
  recordThreadAgentLink,
  attachThreadPrUrl,
  listAgentPrLinks,
  lookupThreadByPrUrl,
} from './thread-store.ts'
import { buildForkedThread } from './fork-thread.ts'

const pr = {
  owner: 'acme',
  repo: 'widgets',
  number: 42,
  url: 'https://github.com/acme/widgets/pull/42',
}
const production: PrProduction = { pr, source: 'pr-create', eventId: 'create-1', createdAt: 1 }
const commit = {
  repository: 'github.com/acme/widgets',
  sha: 'a'.repeat(40),
  source: 'git-commit',
  eventId: 'commit-1',
  createdAt: 1,
} satisfies NonNullable<Thread['commitProductions']>[number]
function thread(id: string, patch: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

test('index preserves every producer/reference and all PRs per thread; hosts stay distinct', () => {
  const index = new ThreadPrRelationshipIndex([
    thread('producer', { prProductions: [production], prRefs: [pr] }),
    thread('reviewer', { prRefs: [pr, { ...pr, number: 43, url: pr.url.replace('42', '43') }] }),
    thread('other-host', {
      prRefs: [{ ...pr, url: pr.url.replace('github.com', 'github.example') }],
    }),
  ])
  assert.deepEqual(
    index.forPr(pr).map((row) => [row.threadId, row.kinds]),
    [
      ['producer', ['referenced', 'produced']],
      ['reviewer', ['referenced']],
    ],
  )
  assert.equal(index.forThread('reviewer').length, 2)
  assert.deepEqual(
    index
      .forPr({ ...pr, url: pr.url.replace('github.com', 'github.example') })
      .map((row) => row.threadId),
    ['other-host'],
  )
  index.upsert(thread('producer', { title: 'Renamed', prProductions: [production] }))
  assert.equal(index.forPr(pr)[0]?.title, 'Renamed')
  index.upsert(thread('reviewer', { archivedAt: 2, prRefs: [pr] }))
  assert.equal(index.forPr(pr).length, 1)
  index.remove('producer')
  assert.deepEqual(index.forPr(pr), [])
})

test('legacy remote links and copied tool results never prove production', () => {
  const source = thread('original', {
    prProductions: [production],
    commitProductions: [commit],
    messages: [
      {
        id: 'message',
        role: 'assistant',
        content: pr.url,
        createdAt: 1,
        toolCalls: [
          { id: 'create-tool', name: 'gh_pr_create', status: 'done', args: {}, result: pr.url },
        ],
      },
    ],
  })
  const fork = buildForkedThread(source)
  assert.ok(fork)
  assert.equal(fork.prProductions, undefined)
  assert.equal(fork.commitProductions, undefined)
  const index = new ThreadPrRelationshipIndex([
    thread('legacy', {
      remoteAgentLink: { provider: 'cursor', agentId: 'agent', prUrl: pr.url, createdAt: 1 },
    }),
  ])
  assert.deepEqual(index.forPr(pr)[0]?.kinds, ['agent-linked'])
})

test('exact commit identities match multiple threads and isolate repositories', () => {
  const index = new ThreadPrRelationshipIndex([
    thread('a', { commitProductions: [commit] }),
    thread('b', { commitProductions: [{ ...commit, eventId: 'commit-2' }] }),
  ])
  assert.equal(index.forCommit(commit.repository, commit.sha).length, 2)
  assert.deepEqual(index.forCommit('github.example/acme/widgets', commit.sha), [])
  assert.deepEqual(index.forCommit(commit.repository, 'b'.repeat(40)), [])
  index.upsert(thread('a'))
  assert.equal(index.forCommit(commit.repository, commit.sha).length, 1)
})

test('native file evidence survives stale saves, incrementally updates cache, and never crosses projects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-pr-relations-'))
  const previous = process.env['COPSE_WORKSPACE_DIR']
  process.env['COPSE_WORKSPACE_DIR'] = root
  try {
    const stale = thread('producer')
    await createThread('project', stale)
    await createThread('project', thread('reviewer'))
    await createThread('other-project', thread('producer'))
    assert.deepEqual(await lookupPrThreadRelationships('project', pr), [])
    await recordThreadPrProduction('project', 'producer', production)
    await recordThreadCommitProduction('project', 'producer', commit)
    await recordThreadPrRefs('project', 'reviewer', [pr])
    assert.equal((await lookupPrThreadRelationships('project', pr)).length, 2)
    assert.deepEqual(await lookupThreadPrRelationships('project', 'producer'), [
      { pr, kinds: ['referenced', 'produced'] },
    ])
    assert.deepEqual(await lookupThreadPrRelationships('other-project', 'producer'), [])
    assert.deepEqual(await lookupPrThreadRelationships('other-project', pr), [])
    await updateMeta('project', 'producer', {
      title: 'Renamed',
      prProductions: [],
      commitProductions: [],
    })
    assert.equal((await lookupPrThreadRelationships('project', pr))[0]?.title, 'Renamed')
    await saveProjectThread('project', stale)
    assert.deepEqual((await getThreadMeta('project', 'producer'))?.prProductions, [production])
    assert.equal(
      (await lookupCommitThreadProductions('project', commit.repository, commit.sha)).length,
      1,
    )
    await recordThreadPrProduction('project', 'producer', production)
    await assert.rejects(
      recordThreadPrProduction('project', 'producer', { ...production, createdAt: 2 }),
      /Conflicting/,
    )
    await assert.rejects(
      recordThreadCommitProduction('project', 'missing', commit),
      /missing thread/,
    )
    assert.equal((await lookupPrThreadRelationships('project', pr)).length, 2)
    await updateMeta('project', 'reviewer', { archivedAt: 2 })
    assert.equal((await lookupPrThreadRelationships('project', pr)).length, 1)
    await deleteProjectThread('project', 'producer')
    assert.deepEqual(await lookupPrThreadRelationships('project', pr), [])
    assert.deepEqual(
      await lookupCommitThreadProductions('project', commit.repository, commit.sha),
      [],
    )
  } finally {
    if (previous === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('remote index upgrade retains multiple linked threads and single-result lookup refuses ambiguity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-agent-pr-relations-'))
  const previous = process.env['COPSE_WORKSPACE_DIR']
  process.env['COPSE_WORKSPACE_DIR'] = root
  try {
    for (const id of ['a', 'b']) {
      await createThread('project', thread(id))
      await recordThreadAgentLink('project', id, { provider: 'cursor', agentId: id, createdAt: 1 })
      await attachThreadPrUrl('project', id, [pr])
    }
    assert.equal((await listAgentPrLinks('project')).length, 2)
    assert.equal(await lookupThreadByPrUrl('project', pr.url), null)
    assert.equal((await lookupPrThreadRelationships('project', pr)).length, 2)
    assert.ok(
      (await lookupPrThreadRelationships('project', pr)).every(
        (row) => !row.kinds.includes('produced'),
      ),
    )
  } finally {
    if (previous === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previous
    rmSync(root, { recursive: true, force: true })
  }
})
