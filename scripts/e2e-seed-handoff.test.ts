import { it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  SqliteThreadIndex,
  THREAD_INDEX_FILE,
} from '../packages/thread-store/src/sqlite-thread-index.ts'

it('restores the pending fixture after an old app overwrites config, then preserves later app writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-e2e-seed-'))
  const config = join(root, 'config.json')
  const pending = join(root, '.e2e-pending-config.json')
  const launcher = resolve('tests/e2e/electron-shell/apply-seed-config.cjs')
  const launch = (): Buffer =>
    execFileSync(process.execPath, [
      '-e',
      'require(process.argv[1]).applyPendingSeedConfig(process.argv[2])',
      launcher,
      root,
    ])
  try {
    const seeded = JSON.stringify({ projects: [{ id: 'seeded' }], activeProjectId: 'seeded' })
    writeFileSync(config, seeded)
    writeFileSync(pending, seeded)
    // The outgoing Electron process persists the empty project list it loaded.
    writeFileSync(config, JSON.stringify({ projects: [] }))
    launch()
    assert.equal(readFileSync(config, 'utf8'), seeded)
    assert.equal(existsSync(pending), false)

    // A subsequent reload without a new seed must preserve product persistence.
    const updated = JSON.stringify({ projects: [{ id: 'created-in-app' }] })
    writeFileSync(config, updated)
    launch()
    assert.equal(readFileSync(config, 'utf8'), updated)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('resets only reseeded projections after shutdown and preserves them on ordinary relaunch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-e2e-index-seed-'))
  const workspace = join(root, 'custom-workspace')
  const project = join(workspace, 'seeded')
  const untouched = join(workspace, 'untouched')
  mkdirSync(project, { recursive: true })
  mkdirSync(untouched)
  const dbPath = join(project, THREAD_INDEX_FILE)
  const marker = join(project, '.e2e-reset-thread-index')
  const launcher = resolve('tests/e2e/electron-shell/apply-seed-config.cjs')
  const launch = (): Buffer =>
    execFileSync(process.execPath, [
      '-e',
      'require(process.argv[1]).applyPendingSeedConfig(process.argv[2], process.argv[3])',
      launcher,
      root,
      workspace,
    ])
  const seed = {
    id: 'thread',
    title: 'New chat',
    status: 'idle',
    model: 'claude-sonnet-4-6',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  } satisfies import('../packages/thread-store/src/thread-types.ts').Thread
  try {
    const old = new SqliteThreadIndex(dbPath)
    try {
      await old.replaceAll([{ ...seed, worktreeChoice: 'shared' }])
      // A fixture replaces authoritative files while the old app still owns SQLite.
      const threadDir = join(project, seed.id)
      mkdirSync(threadDir)
      writeFileSync(join(threadDir, 'meta.json'), JSON.stringify(seed))
      writeFileSync(join(threadDir, 'events.jsonl'), '')
      writeFileSync(marker, '')
      assert.equal((await old.metas())[0]?.worktreeChoice, 'shared')
    } finally {
      old.close()
    }
    // Include files that may be left by an interrupted process.
    for (const suffix of ['-wal', '-shm', '-journal']) writeFileSync(dbPath + suffix, '')
    writeFileSync(join(project, 'catalog.jsonl'), 'stale')
    writeFileSync(join(untouched, THREAD_INDEX_FILE), 'keep')
    launch()
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      assert.equal(existsSync(dbPath + suffix), false)
    assert.equal(existsSync(marker), false)
    assert.equal(existsSync(join(project, 'catalog.jsonl')), false)
    assert.equal(readFileSync(join(project, seed.id, 'meta.json'), 'utf8'), JSON.stringify(seed))
    assert.equal(readFileSync(join(project, seed.id, 'events.jsonl'), 'utf8'), '')
    assert.equal(readFileSync(join(untouched, THREAD_INDEX_FILE), 'utf8'), 'keep')
    const rebuilt = new SqliteThreadIndex(dbPath)
    try {
      assert.equal(rebuilt.ready, false)
      await rebuilt.replaceAll([seed])
      assert.equal((await rebuilt.metas())[0]?.worktreeChoice, undefined)
    } finally {
      rebuilt.close()
    }
    const bytes = readFileSync(dbPath)
    launch()
    assert.deepEqual(readFileSync(dbPath), bytes, 'ordinary relaunch must retain the index')
    const retained = new SqliteThreadIndex(dbPath)
    try {
      assert.equal(retained.ready, true, 'ordinary relaunch must not require a rebuild')
    } finally {
      retained.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
