import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, Thread } from '@shared/types'
import {
  loadProjectThreads,
  saveProjectThread,
  saveProjectThreads,
  deleteProjectThread,
  loadProjectCatalog,
  createThread,
  appendMessage,
  updateMeta,
  getThreadMeta,
  upsertThreadAgentLink,
  lookupThreadByPrUrl,
  rebuildAgentPrIndex,
} from './thread-store.ts'

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

  it('returns an empty list for an unknown project', async () => {
    assert.deepEqual(await loadProjectThreads('nope'), [])
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

    it('updateMeta on a never-created thread is a no-op', async () => {
      await updateMeta('proj-1', 'ghost', { title: 'x' })
      assert.deepEqual(await loadProjectThreads('proj-1'), [])
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

  it('records a launch link on an existing thread and reads it back', async () => {
    await createThread('proj-1', thread('t1'))
    await upsertThreadAgentLink('proj-1', 't1', {
      provider: 'cursor',
      agentId: 'agent-1',
      runId: 'run-1',
      branch: 'claude/feature',
      repo: 'copse-dev/agent-pane',
      createdAt: 123,
    })
    const meta = await getThreadMeta('proj-1', 't1')
    assert.ok(meta)
    assert.deepEqual(meta.remoteAgentLink, {
      provider: 'cursor',
      agentId: 'agent-1',
      runId: 'run-1',
      branch: 'claude/feature',
      repo: 'copse-dev/agent-pane',
      createdAt: 123,
    })
  })

  it('attaching a prUrl folds into the link and the reverse index', async () => {
    await createThread('proj-1', thread('t1'))
    await upsertThreadAgentLink('proj-1', 't1', {
      provider: 'anthropic',
      agentId: 'agent-1',
      createdAt: 1,
    })
    await upsertThreadAgentLink('proj-1', 't1', {
      prUrl: 'https://github.com/copse-dev/agent-pane/pull/42',
    })

    const meta = await getThreadMeta('proj-1', 't1')
    assert.ok(meta)
    const link = meta.remoteAgentLink
    assert.ok(link)
    assert.equal(link.prUrl, 'https://github.com/copse-dev/agent-pane/pull/42')
    // Launch identity survives the prUrl patch.
    assert.equal(link.agentId, 'agent-1')

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
    await upsertThreadAgentLink('proj-1', 't1', {
      provider: 'cursor',
      agentId: 'a',
      prUrl: 'https://github.com/o/r/pull/7',
      createdAt: 1,
    })
    const hit = await lookupThreadByPrUrl('proj-1', 'https://github.com/o/r/pull/7/')
    assert.equal(hit?.threadId, 't1')
  })

  it('drops a prUrl patch that arrives before any launch was recorded', async () => {
    await createThread('proj-1', thread('t1'))
    await upsertThreadAgentLink('proj-1', 't1', {
      prUrl: 'https://github.com/o/r/pull/1',
    })
    const meta = await getThreadMeta('proj-1', 't1')
    assert.ok(meta)
    assert.equal(meta.remoteAgentLink, undefined)
    assert.equal(await lookupThreadByPrUrl('proj-1', 'https://github.com/o/r/pull/1'), null)
  })

  it('upsert on a never-created thread is a no-op', async () => {
    await upsertThreadAgentLink('proj-1', 'ghost', {
      provider: 'cursor',
      agentId: 'a',
      createdAt: 1,
    })
    assert.deepEqual(await loadProjectThreads('proj-1'), [])
  })

  it('rebuilds the reverse index from thread metas', async () => {
    await createThread('proj-1', thread('t1'))
    await createThread('proj-1', thread('t2'))
    await upsertThreadAgentLink('proj-1', 't1', {
      provider: 'cursor',
      agentId: 'a1',
      prUrl: 'https://github.com/o/r/pull/1',
      createdAt: 1,
    })
    await upsertThreadAgentLink('proj-1', 't2', {
      provider: 'anthropic',
      agentId: 'a2',
      prUrl: 'https://github.com/o/r/pull/2',
      createdAt: 2,
    })

    const rebuilt = await rebuildAgentPrIndex('proj-1')
    assert.equal(rebuilt.length, 2)
    assert.equal(
      (await lookupThreadByPrUrl('proj-1', 'https://github.com/o/r/pull/2'))?.threadId,
      't2',
    )
  })

  it('link survives an unrelated updateMeta patch (no clobber)', async () => {
    await createThread('proj-1', thread('t1'))
    await upsertThreadAgentLink('proj-1', 't1', {
      provider: 'cursor',
      agentId: 'a',
      createdAt: 1,
    })
    await updateMeta('proj-1', 't1', { title: 'renamed' })
    const meta = await getThreadMeta('proj-1', 't1')
    assert.ok(meta)
    assert.equal(meta.title, 'renamed')
    const link = meta.remoteAgentLink
    assert.ok(link)
    assert.equal(link.agentId, 'a')
  })
})
