import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Thread } from '@shared/types'
import { storageDelete, storageGet, storageSet } from './storage.ts'
import {
  loadProjectThreads,
  saveProjectThread,
  saveProjectThreads,
  deleteProjectThread,
} from './thread-persistence.ts'

function thread(id: string, draftPrompt?: string): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    ...(draftPrompt !== undefined ? { draftPrompt } : {}),
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('thread-persistence', () => {
  let userDataDir: string
  let previousUserData: string | undefined

  beforeEach(() => {
    previousUserData = process.env['COPSE_PANEL_USER_DATA']
    userDataDir = mkdtempSync(join(tmpdir(), 'copse-thread-persist-'))
    process.env['COPSE_PANEL_USER_DATA'] = userDataDir
    storageDelete('projects')
  })

  afterEach(() => {
    if (previousUserData === undefined) {
      delete process.env['COPSE_PANEL_USER_DATA']
    } else {
      process.env['COPSE_PANEL_USER_DATA'] = previousUserData
    }
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('round-trips a single thread file', async () => {
    await saveProjectThread('proj-1', thread('t1', 'draft text'))
    const loaded = await loadProjectThreads('proj-1')
    assert.equal(loaded.length, 1)
    const first = loaded[0]
    assert.ok(first)
    assert.equal(first.id, 't1')
    assert.equal(first.draftPrompt, 'draft text')
  })

  it('saveProjectThreads removes deleted thread files', async () => {
    await saveProjectThreads('proj-1', [thread('t1'), thread('t2')])
    await saveProjectThreads('proj-1', [thread('t1')])
    const loaded = await loadProjectThreads('proj-1')
    assert.deepEqual(
      loaded.map((t) => t.id),
      ['t1'],
    )
    const dir = join(userDataDir, 'threads', 'proj-1')
    assert.deepEqual(readdirSync(dir).sort(), ['t1.json'])
  })

  it('deleteProjectThread removes one file', async () => {
    await saveProjectThreads('proj-1', [thread('t1'), thread('t2')])
    await deleteProjectThread('proj-1', 't2')
    const loaded = await loadProjectThreads('proj-1')
    assert.deepEqual(
      loaded.map((t) => t.id),
      ['t1'],
    )
  })

  it('migrates legacy electron-store blob and deletes the legacy key', async () => {
    storageSet('threads:proj-1', [thread('legacy-1'), thread('legacy-2')])
    const loaded = await loadProjectThreads('proj-1')
    assert.deepEqual(loaded.map((t) => t.id).sort(), ['legacy-1', 'legacy-2'])
    assert.equal(storageGet('threads:proj-1'), undefined)
    assert.ok(existsSync(join(userDataDir, 'threads', 'proj-1', 'legacy-1.json')))
  })

  it('saveProjectThread only touches one thread file', async () => {
    await saveProjectThreads('proj-1', [thread('t1'), thread('t2')])
    await saveProjectThread('proj-1', thread('t1', 'updated draft'))
    const raw = readFileSync(join(userDataDir, 'threads', 'proj-1', 't1.json'), 'utf8')
    assert.match(raw, /updated draft/)
    const t2Raw = readFileSync(join(userDataDir, 'threads', 'proj-1', 't2.json'), 'utf8')
    assert.doesNotMatch(t2Raw, /updated draft/)
  })
})
