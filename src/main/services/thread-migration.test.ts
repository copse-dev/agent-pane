import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Thread } from '@shared/types'
import { migrateLegacyThreads } from './thread-migration.ts'
import { loadProjectThreads, saveProjectThread } from './thread-store.ts'

function legacyThread(id: string, draftPrompt?: string): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [{ id: `${id}-u`, role: 'user', content: 'hi', toolCalls: [], createdAt: 1 }],
    usage: { inputTokens: 0, outputTokens: 0 },
    ...(draftPrompt !== undefined ? { draftPrompt } : {}),
    createdAt: 1,
    updatedAt: 1,
  }
}

/** Write a thread in the pre-#644 shape: one JSON blob per thread under userData/threads/. */
function seedLegacy(userData: string, projectId: string, thread: Thread): void {
  const dir = join(userData, 'threads', projectId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${thread.id}.json`), `${JSON.stringify(thread)}\n`)
}

describe('thread-migration', () => {
  let userData: string
  let workspace: string
  let prevUserData: string | undefined
  let prevWorkspace: string | undefined

  beforeEach(() => {
    prevUserData = process.env['COPSE_PANEL_USER_DATA']
    prevWorkspace = process.env['COPSE_WORKSPACE_DIR']
    userData = mkdtempSync(join(tmpdir(), 'copse-mig-ud-'))
    workspace = mkdtempSync(join(tmpdir(), 'copse-mig-ws-'))
    process.env['COPSE_PANEL_USER_DATA'] = userData
    process.env['COPSE_WORKSPACE_DIR'] = workspace
  })

  afterEach(() => {
    if (prevUserData === undefined) delete process.env['COPSE_PANEL_USER_DATA']
    else process.env['COPSE_PANEL_USER_DATA'] = prevUserData
    if (prevWorkspace === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = prevWorkspace
    rmSync(userData, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  it('is a no-op when there is no legacy store', async () => {
    const result = await migrateLegacyThreads()
    assert.equal(result.ranMigration, false)
    assert.equal(result.migrated, 0)
  })

  it('imports legacy threads into the new store and archives the old dir', async () => {
    seedLegacy(userData, 'proj-1', legacyThread('t1', 'draft'))
    seedLegacy(userData, 'proj-1', legacyThread('t2'))
    seedLegacy(userData, 'proj-2', legacyThread('t3'))

    const result = await migrateLegacyThreads()
    assert.deepEqual(result, { ranMigration: true, projects: 2, migrated: 3, skipped: 0 })

    const p1 = await loadProjectThreads('proj-1')
    assert.deepEqual(p1.map((t) => t.id).sort(), ['t1', 't2'])
    assert.equal(p1.find((t) => t.id === 't1')?.draftPrompt, 'draft')
    assert.deepEqual(
      (await loadProjectThreads('proj-2')).map((t) => t.id),
      ['t3'],
    )

    // Old dir archived aside (recoverable), not left in place.
    assert.ok(!existsSync(join(userData, 'threads')))
    assert.ok(existsSync(join(userData, 'threads.pre-copse-workspace')))
  })

  it('skips malformed legacy files without aborting the run', async () => {
    seedLegacy(userData, 'proj-1', legacyThread('good'))
    mkdirSync(join(userData, 'threads', 'proj-1'), { recursive: true })
    writeFileSync(join(userData, 'threads', 'proj-1', 'bad.json'), '{not json')

    const result = await migrateLegacyThreads()
    assert.equal(result.migrated, 1)
    assert.equal(result.skipped, 1)
    assert.deepEqual(
      (await loadProjectThreads('proj-1')).map((t) => t.id),
      ['good'],
    )
  })

  it('never clobbers a thread that already exists in the new store', async () => {
    // A thread already migrated/edited in the new store.
    await saveProjectThread('proj-1', legacyThread('t1', 'new-store version'))
    // A stale legacy blob for the same id.
    seedLegacy(userData, 'proj-1', legacyThread('t1', 'OLD version'))

    const result = await migrateLegacyThreads()
    assert.equal(result.skipped, 1)
    assert.equal(result.migrated, 0)
    const t1 = (await loadProjectThreads('proj-1')).find((t) => t.id === 't1')
    assert.equal(t1?.draftPrompt, 'new-store version')
  })
})
