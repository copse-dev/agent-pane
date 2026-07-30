import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
// A raw `require` (rather than `import * as`) so this is the exact module
// object thread-store.ts's own `require("node:fs")` resolves to — see #1222.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
const fsModule: typeof import('node:fs') = require('node:fs')
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LLMMessage, Message, Thread } from '@shared/types'
import {
  loadProjectThreads,
  loadAllProjectThreads,
  saveProjectThread,
  saveProjectThreads,
  deleteProjectThread,
  loadProjectCatalog,
  createThread,
  appendMessage,
  updateMeta,
  getThreadMeta,
  recordThreadAgentLink,
  attachThreadPrUrl,
  lookupThreadByPrUrl,
  rebuildAgentPrIndex,
  listAgentPrLinks,
  listOrphanProjectStores,
  loadAgentHistory,
  saveAgentHistory,
  clearAgentHistory,
  agentHistoryExists,
  loadAcpSessionBinding,
  saveAcpSessionBinding,
  clearAcpSessionBinding,
  type AcpSessionBinding,
  findThreadOwners,
} from './thread-store.ts'
import { storageSet } from './storage/storage.ts'
import { runSerialized } from './storage/write-queue.ts'
import { parseGithubPrUrl, type GithubPrRef } from '@shared/git/github-pr-url.ts'

/** Build PR refs from URL strings, matching what the link store feeds attach. */
function prRefs(...urls: string[]): GithubPrRef[] {
  return urls.map(parseGithubPrUrl).filter((r): r is GithubPrRef => r !== null)
}

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function userMsg(id: string, content: string): Message {
  return { id, role: 'user', content, toolCalls: [], createdAt: 10 }
}

function assistantMsg(id: string, content: string, result: string): Message {
  return {
    id,
    role: 'assistant',
    content,
    toolCalls: [{ id: `${id}-tc`, name: 'read_file', args: { path: 'x' }, status: 'done', result }],
    createdAt: 20,
  }
}

describe('thread-store', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-thread-store-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('lists orphaned thread stores, excluding known project ids (#997)', async () => {
    await saveProjectThread('known', thread('t1'))
    await saveProjectThread('orphan', thread('t2', { title: 'lost' }))
    await saveProjectThread('orphan', thread('t3'))

    const orphans = await listOrphanProjectStores(['known'])
    assert.equal(orphans.length, 1)
    const [first] = orphans
    assert.ok(first)
    assert.equal(first.id, 'orphan')
    assert.equal(first.threadCount, 2)
  })

  it('reports no orphans when every store has a project entry (#997)', async () => {
    await saveProjectThread('p1', thread('t1'))
    await saveProjectThread('p2', thread('t2'))
    assert.deepEqual(await listOrphanProjectStores(['p1', 'p2']), [])
  })

  it('round-trips a thread with messages, tool results, and metadata', async () => {
    const t = thread('t1', {
      draftPrompt: 'draft text',
      workingBrief: 'fix the bug',
      messages: [userMsg('u1', 'hello'), assistantMsg('a1', 'on it', 'file contents\nline 2')],
    })
    await saveProjectThread('proj-1', t)
    const loaded = await loadProjectThreads('proj-1')
    assert.equal(loaded.length, 1)
    assert.deepEqual(loaded[0], t)
  })

  it('round-trips optional worktree metadata while legacy threads remain shared', async () => {
    await saveProjectThread('proj-1', thread('legacy'))
    const isolated = thread('isolated', {
      gitBranch: 'copse/isolated',
      worktreeChoice: 'worktree',
      worktree: {
        path: '/diagnostic/worktree/path',
        branch: 'copse/isolated',
        baseBranch: 'main',
        baseCommit: 'abc123',
        createdAt: 123,
        seededFromDirtyProject: true,
      },
    })
    await saveProjectThread('proj-1', isolated)

    const loaded = await loadProjectThreads('proj-1')
    assert.equal(loaded.find((candidate) => candidate.id === 'legacy')?.worktree, undefined)
    assert.deepEqual(
      loaded.find((candidate) => candidate.id === 'isolated'),
      isolated,
    )
  })

  it('stores prose as OKF files and results as blobs', async () => {
    await saveProjectThread(
      'proj-1',
      thread('t1', { messages: [assistantMsg('a1', 'prose', 'RESULT')] }),
    )
    const dir = join(root, 'proj-1', 't1')
    assert.ok(existsSync(join(dir, 'events.jsonl')))
    assert.ok(existsSync(join(dir, 'meta.json')))
    assert.match(readFileSync(join(dir, 'messages', 'a1.md'), 'utf8'), /prose/)
    assert.equal(readFileSync(join(dir, 'blobs', 'a1-tc.result.txt'), 'utf8'), 'RESULT')
    // meta.json holds no message bodies.
    assert.doesNotMatch(readFileSync(join(dir, 'meta.json'), 'utf8'), /prose/)
  })

  it('saveProjectThreads removes deleted thread directories', async () => {
    await saveProjectThreads('proj-1', [thread('t1'), thread('t2')])
    await saveProjectThreads('proj-1', [thread('t1')])
    const loaded = await loadProjectThreads('proj-1')
    assert.deepEqual(
      loaded.map((t) => t.id),
      ['t1'],
    )
    assert.ok(!existsSync(join(root, 'proj-1', 't2')))
  })

  it('deleteProjectThread removes one thread directory and its catalog entry', async () => {
    await saveProjectThreads('proj-1', [thread('t1'), thread('t2')])
    await deleteProjectThread('proj-1', 't2')
    const loaded = await loadProjectThreads('proj-1')
    assert.deepEqual(
      loaded.map((t) => t.id),
      ['t1'],
    )
    const catalog = await loadProjectCatalog('proj-1')
    assert.deepEqual(
      catalog.map((e) => e.id),
      ['t1'],
    )
  })

  it('prunes stale message/blob files when a message is removed on re-save', async () => {
    await saveProjectThread(
      'proj-1',
      thread('t1', { messages: [assistantMsg('a1', 'x', 'R'), userMsg('u2', 'y')] }),
    )
    const dir = join(root, 'proj-1', 't1')
    assert.ok(existsSync(join(dir, 'messages', 'u2.md')))
    await saveProjectThread('proj-1', thread('t1', { messages: [assistantMsg('a1', 'x', 'R')] }))
    assert.ok(!existsSync(join(dir, 'messages', 'u2.md')))
    assert.ok(existsSync(join(dir, 'messages', 'a1.md')))
  })

  it('skips a thread whose spine references a missing file rather than dropping the project', async () => {
    await saveProjectThreads('proj-1', [
      thread('good', { messages: [userMsg('u1', 'ok')] }),
      thread('broken', { messages: [assistantMsg('a1', 'x', 'R')] }),
    ])
    // Corrupt "broken" by deleting a referenced blob (crash-mid-write shape).
    rmSync(join(root, 'proj-1', 'broken', 'blobs', 'a1-tc.result.txt'))
    const loaded = await loadProjectThreads('proj-1')
    assert.deepEqual(
      loaded.map((t) => t.id),
      ['good'],
    )
  })

  it('detects tampered content via the per-message hash', async () => {
    await saveProjectThread('proj-1', thread('t1', { messages: [userMsg('u1', 'original')] }))
    const file = join(root, 'proj-1', 't1', 'messages', 'u1.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace('original', 'tampered'))
    const loaded = await loadProjectThreads('proj-1')
    assert.deepEqual(
      loaded.map((t) => t.id),
      [],
    ) // hash mismatch => thread skipped
  })

  it('builds a searchable catalog and filters by query', async () => {
    await saveProjectThreads('proj-1', [
      thread('t1', { title: 'Auth refactor', updatedAt: 200 }),
      thread('t2', { title: 'Docs update', updatedAt: 100, workingBrief: 'rewrite readme' }),
    ])
    const all = await loadProjectCatalog('proj-1')
    assert.deepEqual(
      all.map((e) => e.id),
      ['t1', 't2'],
    ) // newest updatedAt first
    const hits = await loadProjectCatalog('proj-1', 'readme')
    assert.deepEqual(
      hits.map((e) => e.id),
      ['t2'],
    )
  })

  it('rebuilds the catalog from thread dirs when it is missing', async () => {
    await saveProjectThreads('proj-1', [thread('t1', { title: 'Kept' })])
    rmSync(join(root, 'proj-1', 'catalog.jsonl'))
    const catalog = await loadProjectCatalog('proj-1')
    assert.deepEqual(
      catalog.map((e) => e.title),
      ['Kept'],
    )
  })

  it('heals a partial catalog written by a single-thread upsert before rebuild', async () => {
    // External seed (e2e fixtures): thread dirs on disk, no catalog yet.
    await createThread(
      'proj-1',
      thread('seeded-auth', {
        title: 'Auth refactor plan',
        messages: [userMsg('u1', 'How should we refactor the auth layer?')],
        updatedAt: 100,
      }),
    )
    await createThread(
      'proj-1',
      thread('seeded-docs', {
        title: 'Docs cleanup',
        messages: [userMsg('u2', 'Clean up the README and docs index.')],
        updatedAt: 90,
      }),
    )
    // Simulate the race: wipe the catalog, then let updateMeta refresh one line
    // from an empty read (the pre-fix upsert/refresh path).
    rmSync(join(root, 'proj-1', 'catalog.jsonl'))
    writeFileSync(
      join(root, 'proj-1', 'catalog.jsonl'),
      `${JSON.stringify({
        id: 'seeded-docs',
        title: 'Docs cleanup',
        createdAt: 1,
        updatedAt: 90,
        digest: 'Docs cleanup',
        path: 'seeded-docs',
      })}\n`,
    )

    // Query token appears only in the auth thread's first-user digest — a partial
    // catalog that omitted that thread used to return [].
    const hits = await loadProjectCatalog('proj-1', 'the')
    assert.deepEqual(hits.map((e) => e.id).sort(), ['seeded-auth', 'seeded-docs'])
  })

  it('round-trips a nested subagent session through disk', async () => {
    const t = thread('t1', {
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          content: 'exploring',
          createdAt: 5,
          toolCalls: [
            {
              id: 'tc1',
              name: 'explore',
              args: { prompt: 'find it' },
              status: 'done',
              result: 'summary',
              subagent: {
                id: 'sub1',
                kind: 'explore',
                status: 'done',
                prompt: 'find it',
                summary: 'done',
                messages: [{ id: 'sm1', role: 'assistant', content: 'searching', toolCalls: [] }],
              },
            },
          ],
        },
      ],
    })
    await saveProjectThread('proj-1', t)
    assert.ok(existsSync(join(root, 'proj-1', 't1', 'subagents', 'sub1', 'events.jsonl')))
    const loaded = await loadProjectThreads('proj-1')
    assert.deepEqual(loaded[0], t)
  })

  // Loading prefetches a thread's files before folding, discovering refs by
  // walking the spine. A subagent's own refs only become knowable once its
  // `events.jsonl` has been read, so each nesting level costs another round —
  // two levels catch a prefetch that stops recursing after the first.
  it('round-trips a doubly-nested subagent session through disk', async () => {
    const t = thread('t1', {
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          content: 'exploring',
          createdAt: 5,
          toolCalls: [
            {
              id: 'tc1',
              name: 'explore',
              args: {},
              status: 'done',
              result: 'summary',
              subagent: {
                id: 'sub1',
                kind: 'explore',
                status: 'done',
                prompt: 'outer',
                summary: 'outer done',
                messages: [
                  {
                    id: 'sm1',
                    role: 'assistant',
                    content: 'searching',
                    toolCalls: [
                      {
                        id: 'stc1',
                        name: 'explore',
                        args: {},
                        status: 'done',
                        result: 'inner summary',
                        subagent: {
                          id: 'sub2',
                          kind: 'explore',
                          status: 'done',
                          prompt: 'inner',
                          summary: 'inner done',
                          messages: [
                            { id: 'dm1', role: 'assistant', content: 'deep', toolCalls: [] },
                          ],
                        },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    })
    await saveProjectThread('proj-1', t)
    assert.ok(
      existsSync(
        join(root, 'proj-1', 't1', 'subagents', 'sub1', 'subagents', 'sub2', 'events.jsonl'),
      ),
    )
    const loaded = await loadProjectThreads('proj-1')
    assert.deepEqual(loaded[0], t)
  })

  it('skips a thread whose subagent spine references a missing file', async () => {
    const t = thread('broken', {
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          content: 'exploring',
          createdAt: 5,
          toolCalls: [
            {
              id: 'tc1',
              name: 'explore',
              args: {},
              status: 'done',
              result: 'summary',
              subagent: {
                id: 'sub1',
                kind: 'explore',
                status: 'done',
                prompt: 'find it',
                summary: 'done',
                messages: [{ id: 'sm1', role: 'assistant', content: 'searching', toolCalls: [] }],
              },
            },
          ],
        },
      ],
    })
    await saveProjectThreads('proj-1', [thread('good', { messages: [userMsg('u1', 'ok')] }), t])
    rmSync(join(root, 'proj-1', 'broken', 'subagents', 'sub1', 'messages', 'sm1.md'))
    const loaded = await loadProjectThreads('proj-1')
    assert.deepEqual(
      loaded.map((t2) => t2.id),
      ['good'],
    )
  })

  it('returns an empty list for an unknown project', async () => {
    assert.deepEqual(await loadProjectThreads('nope'), [])
  })

  // Async prefetch yields to the event loop. loadAll must take the same
  // per-project queue as saves — otherwise a concurrent save can tear the
  // directory mid-read. Holding the queue key proves the load waits.
  it('loadAllProjectThreads serializes behind an in-flight project op', async () => {
    storageSet('projects', [{ id: 'p1', path: '/tmp', name: 'p1' }])
    await saveProjectThread('p1', thread('t1', { messages: [userMsg('u1', 'hi')] }))
    // A second store, deliberately absent from `projects` so the load under test
    // ignores it. It exists only as a pacing yardstick below: same async fold, a
    // different queue key, so awaiting it cannot deadlock against `hold`.
    await saveProjectThread('p2', thread('t2', { messages: [userMsg('u2', 'hi')] }))

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const hold = runSerialized('thread-store:p1', async () => {
      await gate
    })

    let settled = false
    const loadP = loadAllProjectThreads().then((threads) => {
      settled = true
      return threads
    })
    // The window has to be long enough that an *unqueued* load would definitely
    // have finished. Event-loop ticks are not: these reads go through the fs
    // threadpool, so a bypassing load is still in flight after a couple of
    // `setTimeout(0)`s — an earlier version of this test used two ticks and
    // passed with the bug still present. Instead, run the same async fold over
    // `p2` several times over: it is strictly more work than the load under
    // test, on a queue `hold` does not block, so once it has finished a load
    // that were not queued would have finished too.
    for (let i = 0; i < 5; i++) await loadProjectThreads('p2')
    assert.equal(settled, false, 'load must still be queued behind the in-flight op')

    release()
    await hold
    const loaded = await loadP
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]?.id, 't1')
  })

  describe('event-level API', () => {
    it('createThread + appendMessage + updateMeta reconstruct a whole-thread save', async () => {
      await createThread('proj-1', thread('t1', { title: 'New chat' }))
      await appendMessage('proj-1', 't1', userMsg('u1', 'hello'))
      await appendMessage('proj-1', 't1', assistantMsg('a1', 'on it', 'file contents'))
      await updateMeta('proj-1', 't1', { title: 'Renamed', updatedAt: 42, draftPrompt: 'wip' })

      const loaded = await loadProjectThreads('proj-1')
      assert.equal(loaded.length, 1)
      assert.deepEqual(loaded[0], {
        ...thread('t1', { title: 'Renamed', updatedAt: 42, draftPrompt: 'wip' }),
        messages: [userMsg('u1', 'hello'), assistantMsg('a1', 'on it', 'file contents')],
      })
    })

    it('appendMessage replaces the spine line for a re-finalized message id without reordering', async () => {
      await createThread('proj-1', thread('t1'))
      await appendMessage('proj-1', 't1', userMsg('u1', 'first'))
      await appendMessage('proj-1', 't1', userMsg('u2', 'second'))
      await appendMessage('proj-1', 't1', userMsg('u1', 'edited'))
      const [loaded] = await loadProjectThreads('proj-1')
      assert.deepEqual(
        loaded?.messages.map((m) => [m.id, m.content]),
        [
          ['u1', 'edited'],
          ['u2', 'second'],
        ],
      )
    })

    it('appendMessage persists late ACP arguments and output across reload', async () => {
      await createThread('proj-1', thread('t1'))
      const initial: Message = {
        id: 'a1',
        role: 'assistant',
        content: '',
        createdAt: 20,
        toolCalls: [
          {
            id: 'acp1',
            name: 'mcp.copse.run_shell',
            args: {},
            kind: 'execute',
            status: 'done',
            result: null,
          },
        ],
      }
      const initialTool = initial.toolCalls[0]
      assert.ok(initialTool)
      const updated: Message = {
        ...initial,
        toolCalls: [
          {
            ...initialTool,
            args: { command: 'npm run typecheck', timeout_ms: 30_000 },
            result: 'Type check passed.\n',
            resultFormat: 'markdown',
          },
        ],
      }

      await appendMessage('proj-1', 't1', initial)
      await appendMessage('proj-1', 't1', updated)

      const [loaded] = await loadProjectThreads('proj-1')
      assert.deepEqual(loaded?.messages, [updated])
      assert.equal(
        readFileSync(join(root, 'proj-1', 't1', 'blobs', 'acp1.result.txt'), 'utf8'),
        'Type check passed.\n',
      )
    })

    it('appendMessage preserves earlier messages (true append, not rewrite)', async () => {
      await createThread('proj-1', thread('t1'))
      await appendMessage('proj-1', 't1', userMsg('u1', 'one'))
      await appendMessage('proj-1', 't1', userMsg('u2', 'two'))
      const [loaded] = await loadProjectThreads('proj-1')
      assert.deepEqual(
        loaded?.messages.map((m) => m.id),
        ['u1', 'u2'],
      )
    })

    it('appendMessage writes only the new line for a new message id, not the whole spine (#1222)', async () => {
      await createThread('proj-1', thread('t1'))
      for (let i = 0; i < 200; i++) {
        await appendMessage('proj-1', 't1', userMsg(`u${String(i)}`, `message number ${String(i)}`))
      }

      // `appendFileSync` and `writeFileSync` are the same underlying Node
      // primitive (the former delegates to the latter with an 'a' flag), so
      // spying on `writeFileSync` alone observes the bytes either one writes.
      const eventsPath = join(root, 'proj-1', 't1', 'events.jsonl')
      const writeSpy = mock.method(fsModule, 'writeFileSync')
      await appendMessage('proj-1', 't1', userMsg('u200', 'the 201st message'))
      mock.restoreAll()

      const bytesWrittenToEvents = writeSpy.mock.calls
        .filter((c) => c.arguments[0] === eventsPath)
        .reduce(
          (sum, c) => sum + (typeof c.arguments[1] === 'string' ? c.arguments[1].length : 0),
          0,
        )
      // One new spine line is well under 500 bytes; a full rewrite of the
      // prior 200 lines would be tens of thousands.
      assert.ok(
        bytesWrittenToEvents > 0 && bytesWrittenToEvents < 500,
        `expected a pure append (~1 line) but wrote ${String(bytesWrittenToEvents)} bytes to events.jsonl`,
      )
    })

    it('updateMeta refreshes the catalog line (title, updatedAt, first-user digest)', async () => {
      await createThread('proj-1', thread('t1', { title: 'Draft' }))
      await appendMessage('proj-1', 't1', userMsg('u1', 'how do I parse JSON'))
      await updateMeta('proj-1', 't1', { title: 'JSON parsing', updatedAt: 500 })

      const [entry] = await loadProjectCatalog('proj-1')
      assert.ok(entry)
      assert.equal(entry.title, 'JSON parsing')
      assert.equal(entry.updatedAt, 500)
      assert.match(entry.digest, /JSON parsing/)
      assert.match(entry.digest, /how do I parse JSON/)
    })

    it('updateMeta clears a field when the patch sets it to undefined', async () => {
      const queued = {
        messageId: 'q1',
        payload: { content: 'later', invokedSkills: [], priorTodos: [] },
        createdAt: 5,
      }
      await createThread('proj-1', thread('t1', { pendingMessages: [queued], queuePaused: true }))
      // The renderer sends an explicit `undefined` for keys it has dropped so the
      // merge deletes them — without this a drained queue would resurrect on load.
      const clearPatch: Record<string, unknown> = {
        pendingMessages: undefined,
        queuePaused: undefined,
      }
      await updateMeta('proj-1', 't1', clearPatch)

      const [loaded] = await loadProjectThreads('proj-1')
      assert.ok(loaded)
      assert.equal('pendingMessages' in loaded, false)
      assert.equal('queuePaused' in loaded, false)
    })

    it('updateMeta on a never-created thread is a no-op', async () => {
      await updateMeta('proj-1', 'ghost', { title: 'x' })
      assert.deepEqual(await loadProjectThreads('proj-1'), [])
    })

    it('updateMeta with archivedAt drops the thread from the catalog', async () => {
      await createThread('proj-1', thread('t1', { title: 'Keep' }))
      await createThread('proj-1', thread('t2', { title: 'Hide' }))
      await updateMeta('proj-1', 't2', { archivedAt: 99, updatedAt: 99 })

      const catalog = await loadProjectCatalog('proj-1')
      assert.deepEqual(catalog.map((e) => e.id).sort(), ['t1'])
      // Directory + meta remain; only the catalog line is removed.
      const loaded = await loadProjectThreads('proj-1')
      assert.equal(loaded.find((t) => t.id === 't2')?.archivedAt, 99)
    })
  })
})

describe('thread-store agent-run ↔ PR link (issue #690, Q6)', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-agent-link-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  const CURSOR_LAUNCH = {
    provider: 'cursor' as const,
    agentId: 'agent-1',
    runId: 'run-1',
    branch: 'claude/feature',
    repo: 'o/r',
    createdAt: 123,
  }

  it('records a launch link on an existing thread and reads it back', async () => {
    await createThread('proj-1', thread('t1'))
    await recordThreadAgentLink('proj-1', 't1', CURSOR_LAUNCH)
    const meta = await getThreadMeta('proj-1', 't1')
    assert.ok(meta)
    assert.deepEqual(meta.remoteAgentLink, CURSOR_LAUNCH)
  })

  it('attaches the PR (canonical url) into the link and the reverse index', async () => {
    await createThread('proj-1', thread('t1'))
    await recordThreadAgentLink('proj-1', 't1', {
      provider: 'anthropic',
      agentId: 'agent-1',
      repo: 'copse-dev/agent-pane',
      createdAt: 1,
    })
    await attachThreadPrUrl(
      'proj-1',
      't1',
      prRefs('https://github.com/copse-dev/agent-pane/pull/42'),
    )

    const meta = await getThreadMeta('proj-1', 't1')
    assert.ok(meta)
    const link = meta.remoteAgentLink
    assert.ok(link)
    assert.equal(link.prUrl, 'https://github.com/copse-dev/agent-pane/pull/42')
    assert.equal(link.agentId, 'agent-1') // launch identity survives

    const hit = await lookupThreadByPrUrl(
      'proj-1',
      'https://github.com/copse-dev/agent-pane/pull/42',
    )
    assert.deepEqual(hit, {
      prUrl: 'https://github.com/copse-dev/agent-pane/pull/42',
      threadId: 't1',
      agentId: 'agent-1',
      provider: 'anthropic',
    })
  })

  it('resolves the index by canonical key regardless of URL trailing slash', async () => {
    await createThread('proj-1', thread('t1'))
    await recordThreadAgentLink('proj-1', 't1', CURSOR_LAUNCH)
    await attachThreadPrUrl('proj-1', 't1', prRefs('https://github.com/o/r/pull/7'))
    const hit = await lookupThreadByPrUrl('proj-1', 'https://github.com/o/r/pull/7/')
    assert.equal(hit?.threadId, 't1')
  })

  it('links a PR whose url points at a sub-tab (/files)', async () => {
    await createThread('proj-1', thread('t1'))
    await recordThreadAgentLink('proj-1', 't1', CURSOR_LAUNCH)
    await attachThreadPrUrl('proj-1', 't1', prRefs('https://github.com/o/r/pull/99/files'))
    const meta = await getThreadMeta('proj-1', 't1')
    // Canonical url stored, /files stripped; still resolvable via the base url.
    assert.equal(meta?.remoteAgentLink?.prUrl, 'https://github.com/o/r/pull/99')
    assert.equal(
      (await lookupThreadByPrUrl('proj-1', 'https://github.com/o/r/pull/99'))?.threadId,
      't1',
    )
  })

  it('picks the launch-repo PR, not a referenced one mentioned first', async () => {
    await createThread('proj-1', thread('t1'))
    await recordThreadAgentLink('proj-1', 't1', CURSOR_LAUNCH) // repo 'o/r'
    await attachThreadPrUrl(
      'proj-1',
      't1',
      // The agent references another repo's PR before naming its own.
      prRefs('https://github.com/other/x/pull/5', 'https://github.com/o/r/pull/9'),
    )
    assert.equal(
      (await getThreadMeta('proj-1', 't1'))?.remoteAgentLink?.prUrl,
      'https://github.com/o/r/pull/9',
    )
  })

  it('attaches nothing when no scraped PR is in the launch repo', async () => {
    await createThread('proj-1', thread('t1'))
    await recordThreadAgentLink('proj-1', 't1', CURSOR_LAUNCH) // repo 'o/r'
    await attachThreadPrUrl('proj-1', 't1', prRefs('https://github.com/other/x/pull/5'))
    assert.equal((await getThreadMeta('proj-1', 't1'))?.remoteAgentLink?.prUrl, undefined)
  })

  it('falls back to the last PR when the launch recorded no repo', async () => {
    await createThread('proj-1', thread('t1'))
    await recordThreadAgentLink('proj-1', 't1', { provider: 'cursor', agentId: 'a', createdAt: 1 })
    await attachThreadPrUrl(
      'proj-1',
      't1',
      prRefs('https://github.com/a/b/pull/1', 'https://github.com/c/d/pull/2'),
    )
    assert.equal(
      (await getThreadMeta('proj-1', 't1'))?.remoteAgentLink?.prUrl,
      'https://github.com/c/d/pull/2',
    )
  })

  it('is write-once: a follow-up PR does not repoint the link or leave a dangling index entry', async () => {
    await createThread('proj-1', thread('t1'))
    await recordThreadAgentLink('proj-1', 't1', CURSOR_LAUNCH)
    await attachThreadPrUrl('proj-1', 't1', prRefs('https://github.com/o/r/pull/1'))
    await attachThreadPrUrl('proj-1', 't1', prRefs('https://github.com/o/r/pull/2'))
    assert.equal(
      (await getThreadMeta('proj-1', 't1'))?.remoteAgentLink?.prUrl,
      'https://github.com/o/r/pull/1',
    )
    // The superseding PR was ignored, so the index maps only the first PR.
    const links = await listAgentPrLinks('proj-1')
    assert.deepEqual(
      links.map((l) => l.prUrl),
      ['https://github.com/o/r/pull/1'],
    )
    assert.equal(await lookupThreadByPrUrl('proj-1', 'https://github.com/o/r/pull/2'), null)
  })

  it('a fresh launch supersedes the prior PR and drops its index entry', async () => {
    await createThread('proj-1', thread('t1'))
    await recordThreadAgentLink('proj-1', 't1', CURSOR_LAUNCH)
    await attachThreadPrUrl('proj-1', 't1', prRefs('https://github.com/o/r/pull/1'))
    // Re-launch a new agent on the same thread.
    await recordThreadAgentLink('proj-1', 't1', { ...CURSOR_LAUNCH, agentId: 'agent-2' })
    const link = (await getThreadMeta('proj-1', 't1'))?.remoteAgentLink
    assert.ok(link)
    assert.equal(link.agentId, 'agent-2')
    assert.equal(link.prUrl, undefined)
    assert.equal(await lookupThreadByPrUrl('proj-1', 'https://github.com/o/r/pull/1'), null)
    assert.deepEqual(await listAgentPrLinks('proj-1'), [])
  })

  it('attach before any launch is a no-op', async () => {
    await createThread('proj-1', thread('t1'))
    await attachThreadPrUrl('proj-1', 't1', prRefs('https://github.com/o/r/pull/1'))
    const meta = await getThreadMeta('proj-1', 't1')
    assert.ok(meta)
    assert.equal(meta.remoteAgentLink, undefined)
    assert.equal(await lookupThreadByPrUrl('proj-1', 'https://github.com/o/r/pull/1'), null)
  })

  it('record on a never-created thread is a no-op', async () => {
    await recordThreadAgentLink('proj-1', 'ghost', CURSOR_LAUNCH)
    assert.deepEqual(await loadProjectThreads('proj-1'), [])
  })

  it('deleting a thread prunes its reverse-index entry', async () => {
    await createThread('proj-1', thread('t1'))
    await recordThreadAgentLink('proj-1', 't1', CURSOR_LAUNCH)
    await attachThreadPrUrl('proj-1', 't1', prRefs('https://github.com/o/r/pull/1'))
    await deleteProjectThread('proj-1', 't1')
    assert.equal(await lookupThreadByPrUrl('proj-1', 'https://github.com/o/r/pull/1'), null)
    assert.deepEqual(await listAgentPrLinks('proj-1'), [])
  })

  it('rebuilds the reverse index from thread metas', async () => {
    await createThread('proj-1', thread('t1'))
    await createThread('proj-1', thread('t2'))
    await recordThreadAgentLink('proj-1', 't1', CURSOR_LAUNCH)
    await attachThreadPrUrl('proj-1', 't1', prRefs('https://github.com/o/r/pull/1'))
    await recordThreadAgentLink('proj-1', 't2', { ...CURSOR_LAUNCH, agentId: 'a2' })
    await attachThreadPrUrl('proj-1', 't2', prRefs('https://github.com/o/r/pull/2'))

    const rebuilt = await rebuildAgentPrIndex('proj-1')
    assert.equal(rebuilt.length, 2)
    assert.equal(
      (await lookupThreadByPrUrl('proj-1', 'https://github.com/o/r/pull/2'))?.threadId,
      't2',
    )
  })

  it('listAgentPrLinks returns every linked PR, rebuilding when the index is absent', async () => {
    await createThread('proj-1', thread('t1'))
    await recordThreadAgentLink('proj-1', 't1', CURSOR_LAUNCH)
    await attachThreadPrUrl('proj-1', 't1', prRefs('https://github.com/o/r/pull/1'))
    // A thread with a launch link but no PR yet must not appear in the index.
    await createThread('proj-1', thread('t2'))
    await recordThreadAgentLink('proj-1', 't2', { ...CURSOR_LAUNCH, agentId: 'a2', repo: 'o/r' })
    // Drop the derived index; listAgentPrLinks must rebuild it from the metas.
    rmSync(join(root, 'proj-1', 'agent-pr-index.jsonl'), { force: true })

    const links = await listAgentPrLinks('proj-1')
    assert.deepEqual(links, [
      {
        prUrl: 'https://github.com/o/r/pull/1',
        threadId: 't1',
        agentId: 'agent-1',
        provider: 'cursor',
      },
    ])
  })

  it('link survives an unrelated updateMeta patch (no clobber)', async () => {
    await createThread('proj-1', thread('t1'))
    await recordThreadAgentLink('proj-1', 't1', CURSOR_LAUNCH)
    await updateMeta('proj-1', 't1', { title: 'renamed' })
    const meta = await getThreadMeta('proj-1', 't1')
    assert.ok(meta)
    assert.equal(meta.title, 'renamed')
    assert.equal(meta.remoteAgentLink?.agentId, 'agent-1')
  })

  it('round-trips provider agent history beside the thread (#993)', async () => {
    await createThread('proj-1', thread('t1'))
    const history: LLMMessage[] = [
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'pong' },
    ]
    await saveAgentHistory('proj-1', 't1', history)
    assert.equal(await agentHistoryExists('proj-1', 't1'), true)
    assert.deepEqual(await loadAgentHistory('proj-1', 't1'), history)
    assert.ok(existsSync(join(root, 'proj-1', 't1', 'agent-history.json')))
  })

  it('fails closed on corrupt or future-version agent-history sidecars', async () => {
    await createThread('proj-1', thread('t1'))
    const path = join(root, 'proj-1', 't1', 'agent-history.json')
    writeFileSync(path, '{not json')
    assert.deepEqual(await loadAgentHistory('proj-1', 't1'), [])

    writeFileSync(
      path,
      `${JSON.stringify({ v: 99, messages: [{ role: 'user', content: 'x' }] })}\n`,
    )
    assert.deepEqual(await loadAgentHistory('proj-1', 't1'), [])

    writeFileSync(path, `${JSON.stringify({ v: 1, messages: 'nope' })}\n`)
    assert.deepEqual(await loadAgentHistory('proj-1', 't1'), [])
  })

  it('clearAgentHistory removes the sidecar; deleteProjectThread removes it with the dir', async () => {
    await createThread('proj-1', thread('t1'))
    await saveAgentHistory('proj-1', 't1', [{ role: 'user', content: 'x' }])
    await clearAgentHistory('proj-1', 't1')
    assert.equal(await agentHistoryExists('proj-1', 't1'), false)

    await saveAgentHistory('proj-1', 't1', [{ role: 'user', content: 'y' }])
    await deleteProjectThread('proj-1', 't1')
    assert.equal(existsSync(join(root, 'proj-1', 't1')), false)
  })

  it('round-trips a private ACP session binding beside the thread', async () => {
    await createThread('proj-1', thread('t1'))
    const binding: AcpSessionBinding = {
      v: 1,
      agentId: 'codex',
      sessionId: 'opaque-session-id',
      protocolVersion: 1,
      executionTarget: { kind: 'local' },
      workspaceIdentity: '/workspace/project',
      agentConfigGeneration: 3,
      createdBy: 'copse',
      lastAttachedAt: 123,
    }

    await saveAcpSessionBinding('proj-1', 't1', binding)

    assert.deepEqual(await loadAcpSessionBinding('proj-1', 't1'), binding)
    const dir = join(root, 'proj-1', 't1')
    assert.ok(existsSync(join(dir, 'acp-session.json')))
    assert.doesNotMatch(readFileSync(join(dir, 'meta.json'), 'utf8'), /opaque-session-id/)
    assert.doesNotMatch(readFileSync(join(dir, 'events.jsonl'), 'utf8'), /opaque-session-id/)
  })

  it('fails closed on corrupt, future, or incomplete ACP session bindings', async () => {
    await createThread('proj-1', thread('t1'))
    const path = join(root, 'proj-1', 't1', 'acp-session.json')

    writeFileSync(path, '{not json')
    assert.equal(await loadAcpSessionBinding('proj-1', 't1'), null)

    writeFileSync(path, `${JSON.stringify({ v: 99, sessionId: 'stale' })}\n`)
    assert.equal(await loadAcpSessionBinding('proj-1', 't1'), null)

    writeFileSync(
      path,
      `${JSON.stringify({
        v: 1,
        agentId: 'codex',
        sessionId: 'missing-fields',
      })}\n`,
    )
    assert.equal(await loadAcpSessionBinding('proj-1', 't1'), null)
  })

  it('clears an ACP binding explicitly and with thread deletion', async () => {
    await createThread('proj-1', thread('t1'))
    const binding: AcpSessionBinding = {
      v: 1,
      agentId: 'codex',
      sessionId: 'opaque-session-id',
      protocolVersion: 1,
      executionTarget: { kind: 'ssh', hostId: 'dev', remoteCwd: '/repo' },
      workspaceIdentity: '/repo',
      agentConfigGeneration: 0,
      createdBy: 'external',
      lastAttachedAt: 123,
    }

    await saveAcpSessionBinding('proj-1', 't1', binding)
    await clearAcpSessionBinding('proj-1', 't1')
    assert.equal(await loadAcpSessionBinding('proj-1', 't1'), null)

    await saveAcpSessionBinding('proj-1', 't1', binding)
    await deleteProjectThread('proj-1', 't1')
    assert.equal(existsSync(join(root, 'proj-1', 't1')), false)
  })

  it('findThreadOwners resolves zero/one/many project matches', async () => {
    assert.deepEqual(await findThreadOwners('missing'), [])
    await createThread('proj-a', thread('solo'))
    assert.deepEqual(await findThreadOwners('solo'), ['proj-a'])
    await createThread('proj-a', thread('shared'))
    await createThread('proj-b', thread('shared'))
    assert.deepEqual((await findThreadOwners('shared')).sort(), ['proj-a', 'proj-b'])
  })
})
