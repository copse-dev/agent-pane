import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { configureThreadStore } from './environment.ts'
import type { Thread } from './thread-types.ts'
import { THREAD_INDEX_FILE, SqliteThreadIndex } from './sqlite-thread-index.ts'
import {
  appendMessage,
  closeThreadStoreIndexes,
  deleteProjectThread,
  loadProjectThreadMetas,
  loadProjectThreadMetasFromFiles,
  loadThreadMessages,
  lookupPrThreadRelationships,
  lookupThreadPrRelationships,
  lookupCommitThreadProductions,
  recordThreadPrProduction,
  recordThreadCommitProduction,
  saveProjectThread,
  saveProjectThreads,
  updateMeta,
} from './thread-store.ts'

const pr = {
  owner: 'acme',
  repo: 'widget',
  number: 42,
  url: 'https://github.com/acme/widget/pull/42',
}
const commit = {
  repository: 'github.com/acme/widget',
  sha: 'a'.repeat(40),
  eventId: 'commit-1',
  source: 'git-commit',
  createdAt: 2,
} satisfies NonNullable<Thread['commitProductions']>[number]

function thread(id: string, fields: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  }
}

describe('persistent SQLite thread projection', () => {
  let root: string
  let dbPath: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'thread-sqlite-'))
    dbPath = join(root, 'p', THREAD_INDEX_FILE)
    configureThreadStore({ workspaceRoot: () => root })
  })
  afterEach(() => {
    closeThreadStoreIndexes()
    configureThreadStore()
    rmSync(root, { recursive: true, force: true })
  })

  it('preserves metadata and transcript source bytes when building and restarting', async () => {
    await saveProjectThread('p', thread('producer'))
    await appendMessage('p', 'producer', {
      id: 'm1',
      role: 'user',
      content: pr.url,
      toolCalls: [],
      createdAt: 3,
    })
    const source = join(root, 'p', 'producer', 'meta.json')
    const before = readFileSync(source)
    const files = await loadProjectThreadMetasFromFiles('p')
    assert.deepEqual(await loadProjectThreadMetas('p'), files)
    closeThreadStoreIndexes()
    assert.deepEqual(await loadProjectThreadMetas('p'), files)
    assert.deepEqual(readFileSync(source), before)
    assert.equal((await loadThreadMessages('p', 'producer'))[0]?.content, pr.url)
  })

  it('uses the persisted index after restart without opening per-thread files', async (t) => {
    await saveProjectThread('p', thread('t', { prRefs: [pr], commitProductions: [commit] }))
    await loadProjectThreadMetas('p')
    closeThreadStoreIndexes()
    t.mock.method(fs, 'open', () => {
      throw new Error('Source reader must not run')
    })
    assert.equal((await loadProjectThreadMetas('p'))[0]?.title, 't')
    assert.equal((await lookupPrThreadRelationships('p', pr))[0]?.threadId, 't')
    assert.equal((await lookupThreadPrRelationships('p', 't'))[0]?.pr.number, 42)
    assert.equal(
      (await lookupCommitThreadProductions('p', commit.repository, commit.sha))[0]?.threadId,
      't',
    )
  })

  it('retains many-to-many references, native producers and exact commit evidence', async () => {
    const otherPr = { ...pr, number: 43, url: 'https://github.com/acme/widget/pull/43' }
    await saveProjectThread('p', thread('author', { prRefs: [pr] }))
    await saveProjectThread('p', thread('reviewer', { prRefs: [pr, otherPr] }))
    await loadProjectThreadMetas('p')
    await recordThreadPrProduction('p', 'author', {
      pr,
      eventId: 'create-1',
      source: 'pr-create',
      createdAt: 4,
    })
    await recordThreadCommitProduction('p', 'author', commit)
    await recordThreadCommitProduction('p', 'reviewer', { ...commit, eventId: 'commit-2' })
    closeThreadStoreIndexes()
    const rows = await lookupPrThreadRelationships('p', pr)
    assert.deepEqual(
      rows.map((row) => [row.threadId, row.kinds]),
      [
        ['author', ['referenced', 'produced']],
        ['reviewer', ['referenced']],
      ],
    )
    assert.equal((await lookupThreadPrRelationships('p', 'reviewer')).length, 2)
    assert.equal(
      (await lookupCommitThreadProductions('p', commit.repository, commit.sha)).length,
      2,
    )
    assert.deepEqual(
      await lookupCommitThreadProductions('p', commit.repository, commit.sha.slice(0, 7)),
      [],
    )
    assert.deepEqual(
      await lookupCommitThreadProductions('p', 'github.com/other/widget', commit.sha),
      [],
    )
    assert.deepEqual(
      await lookupPrThreadRelationships('p', {
        ...pr,
        url: 'https://enterprise.test/acme/widget/pull/42',
      }),
      [],
    )
  })

  it('updates title, archive, transcript presence, deletion and bulk replacement', async () => {
    await saveProjectThread('p', thread('t', { prRefs: [pr], commitProductions: [commit] }))
    await loadProjectThreadMetas('p')
    await updateMeta('p', 't', { title: 'renamed' })
    assert.equal((await lookupPrThreadRelationships('p', pr))[0]?.title, 'renamed')
    await appendMessage('p', 't', {
      id: 'm1',
      role: 'user',
      content: 'hello',
      toolCalls: [],
      createdAt: 2,
    })
    assert.equal((await loadProjectThreadMetas('p'))[0]?.messagesLoaded, false)
    await updateMeta('p', 't', { archivedAt: 10 })
    assert.deepEqual(await lookupPrThreadRelationships('p', pr), [])
    assert.deepEqual(await lookupCommitThreadProductions('p', commit.repository, commit.sha), [])
    assert.deepEqual(await loadProjectThreadMetas('p', { includeArchived: false }), [])
    assert.equal((await loadProjectThreadMetas('p')).length, 1)
    await saveProjectThread('p', thread('t', { prRefs: [pr], commitProductions: [commit] }))
    assert.equal((await lookupPrThreadRelationships('p', pr)).length, 1)
    await saveProjectThreads('p', [thread('new', { prRefs: [pr] })])
    assert.deepEqual(
      (await loadProjectThreadMetas('p')).map((row) => row.id),
      ['new'],
    )
    assert.deepEqual(await lookupThreadPrRelationships('p', 't'), [])
    await deleteProjectThread('p', 'new')
    closeThreadStoreIndexes()
    assert.deepEqual(await lookupPrThreadRelationships('p', pr), [])
    assert.deepEqual(await loadProjectThreadMetas('p'), [])
  })

  it('repairs a real process death after a native source write and before projection commit', async () => {
    await saveProjectThread('p', thread('t'))
    await loadProjectThreadMetas('p')
    closeThreadStoreIndexes()
    // Inject the interruption at the filesystem seam, without a product flag.
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { promises as fs } from 'node:fs';
      const { configureThreadStore } = await import('@copse/thread-store/environment.ts');
      const { recordThreadPrProduction } = await import('@copse/thread-store/thread-store.ts');
      configureThreadStore({ workspaceRoot: () => process.env.COPSE_SQLITE_TEST_ROOT });
      const rename = fs.rename;
      fs.rename = async (...args) => { await rename(...args); process.kill(process.pid, 'SIGKILL'); };
      await recordThreadPrProduction('p', 't', ${JSON.stringify({ pr, eventId: 'crash-create', source: 'pr-create', createdAt: 4 })});
    `,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, COPSE_SQLITE_TEST_ROOT: root },
        encoding: 'utf8',
      },
    )
    assert.equal(result.signal, 'SIGKILL', result.stderr)
    const persisted = new SqliteThreadIndex(dbPath)
    assert.deepEqual(persisted.pendingIds(), ['t'])
    persisted.close()
    assert.deepEqual((await lookupPrThreadRelationships('p', pr))[0]?.kinds, [
      'referenced',
      'produced',
    ])
    const repaired = new SqliteThreadIndex(dbPath)
    assert.deepEqual(repaired.pendingIds(), [])
    repaired.close()
  })

  it('repairs interrupted deletes and retries a failed source write from the actual files', async (t) => {
    await saveProjectThread('p', thread('t', { prRefs: [pr] }))
    await loadProjectThreadMetas('p')
    closeThreadStoreIndexes()
    const index = new SqliteThreadIndex(dbPath)
    index.markPending('t')
    rmSync(join(root, 'p', 't'), { recursive: true })
    index.close()
    assert.deepEqual(await lookupPrThreadRelationships('p', pr), [])
    await saveProjectThread('p', thread('t'))
    t.mock.method(fs, 'rename', () => {
      throw new Error('injected source failure')
    })
    await assert.rejects(
      recordThreadPrProduction('p', 't', {
        pr,
        eventId: 'failed',
        source: 'pr-create',
        createdAt: 3,
      }),
      /injected source failure/,
    )
    assert.deepEqual(await lookupPrThreadRelationships('p', pr), [])
  })

  for (const failure of ['missing', 'corrupt', 'version', 'payload']) {
    it(`rebuilds a ${failure} index without modifying source metadata`, async () => {
      await saveProjectThread('p', thread('t', { prRefs: [pr] }))
      const expected = await loadProjectThreadMetas('p')
      closeThreadStoreIndexes()
      if (failure === 'missing') rmSync(dbPath)
      else if (failure === 'corrupt') writeFileSync(dbPath, 'not a database')
      else {
        const db = new DatabaseSync(dbPath)
        db.exec(
          failure === 'version' ? 'PRAGMA user_version=999' : "UPDATE threads SET meta='null'",
        )
        db.close()
      }
      assert.deepEqual(await loadProjectThreadMetas('p'), expected)
      assert.equal((await lookupPrThreadRelationships('p', pr))[0]?.threadId, 't')
    })
  }

  it('rebuilds a copied index against its destination project files', async () => {
    await saveProjectThread('p', thread('t', { title: 'old project', prRefs: [pr] }))
    await loadProjectThreadMetas('p')
    closeThreadStoreIndexes()
    await saveProjectThread('other', thread('t', { title: 'new project' }))
    copyFileSync(dbPath, join(root, 'other', THREAD_INDEX_FILE))
    assert.equal((await loadProjectThreadMetas('other'))[0]?.title, 'new project')
    assert.deepEqual(await lookupPrThreadRelationships('other', pr), [])
  })

  it('does not publish a partial rebuild or retain claims after a failed repair read', async (t) => {
    t.mock.method(console, 'warn', () => undefined)
    await saveProjectThread('p', thread('t'))
    await loadProjectThreadMetas('p')
    closeThreadStoreIndexes()
    const index = new SqliteThreadIndex(dbPath)
    const fault = new DatabaseSync(dbPath)
    fault.exec(
      "CREATE TRIGGER abort_insert BEFORE INSERT ON threads BEGIN SELECT RAISE(FAIL, 'injected rebuild failure'); END",
    )
    fault.close()
    await assert.rejects(index.replaceAll([thread('bad')]), /injected rebuild failure/)
    assert.equal(index.ready, false)
    index.close()
    assert.deepEqual(await lookupPrThreadRelationships('p', pr), [])
    const readFailure = t.mock.method(fs, 'open', () => {
      throw new Error('transient source read failure')
    })
    await recordThreadPrProduction('p', 't', {
      pr,
      source: 'pr-create',
      eventId: 'read-failure',
      createdAt: 3,
    })
    assert.deepEqual(await lookupPrThreadRelationships('p', pr), [])
    readFailure.mock.restore()
    assert.deepEqual((await lookupPrThreadRelationships('p', pr))[0]?.kinds, [
      'referenced',
      'produced',
    ])
  })

  it('indexes nested project paths and isolates matching IDs in other projects', async () => {
    await saveProjectThread('team/p', thread('t', { prRefs: [pr] }))
    await saveProjectThread('other', thread('t'))
    await loadProjectThreadMetas('team/p')
    await loadProjectThreadMetas('other')
    await updateMeta('team/p', 't', { title: 'nested update' })
    closeThreadStoreIndexes()
    assert.equal((await lookupPrThreadRelationships('team/p', pr))[0]?.title, 'nested update')
    assert.deepEqual(await lookupPrThreadRelationships('other', pr), [])
  })

  it('falls back to files for a symlinked cache without touching the target', async (t) => {
    t.mock.method(console, 'warn', () => undefined)
    await saveProjectThread('p', thread('t', { prRefs: [pr] }))
    const outside = join(root, 'target')
    writeFileSync(outside, 'untouched')
    symlinkSync(outside, dbPath)
    assert.equal((await loadProjectThreadMetas('p'))[0]?.id, 't')
    assert.equal((await lookupPrThreadRelationships('p', pr))[0]?.threadId, 't')
    await assert.rejects(updateMeta('p', 't', { title: 'blocked' }), /unsafe or symlink/)
    assert.equal(readFileSync(outside, 'utf8'), 'untouched')
  })

  it('keeps concurrent project rebuilds alive while evicting idle native handles', async (t) => {
    const warnings = t.mock.method(console, 'warn', () => undefined)
    const projects = Array.from({ length: 20 }, (_, i) => `project-${String(i)}`)
    for (const project of projects) await saveProjectThread(project, thread('t', { prRefs: [pr] }))
    const opened = await Promise.all(projects.map((project) => loadProjectThreadMetas(project)))
    assert.equal(opened.length, 20)
    assert.ok(opened.every((rows) => rows[0]?.id === 't'))
    const links = await Promise.all(
      projects.map((project) => lookupPrThreadRelationships(project, pr)),
    )
    assert.ok(links.every((rows) => rows[0]?.threadId === 't'))
    assert.equal(warnings.mock.callCount(), 0)
  })
})
