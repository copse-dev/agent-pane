import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { CanvasArtefact } from '@shared/types/canvas.ts'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import {
  loadCanvasArtefactSummaries,
  readStoredCanvasArtefact,
  rememberCanvasArtefact,
} from './canvas-store.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

const PREVIEW = 'data:image/png;base64,iVBORw0KGgo='

function artefact(overrides: Partial<CanvasArtefact> = {}): CanvasArtefact {
  return {
    title: 'Sales Dashboard',
    mimeType: 'text/html',
    body: '<!doctype html><h1>v1</h1>',
    threadId: 'thread-1',
    ...overrides,
  }
}

describe('canvas store', () => {
  let store = ''
  let workspace = ''
  let restoreWorkspace: (() => void) | null = null
  let previousStoreDir: string | undefined

  beforeEach(async () => {
    store = await mkdtemp(join(tmpdir(), 'canvas-store-'))
    workspace = await mkdtemp(join(tmpdir(), 'canvas-workspace-'))
    previousStoreDir = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = store
    restoreWorkspace = setWorkspaceRootForTest(workspace)
  })

  afterEach(async () => {
    restoreWorkspace?.()
    restoreWorkspace = null
    if (previousStoreDir === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousStoreDir
    await rm(store, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  })

  it('reads back an artefact and its thumbnail after the renderer is gone', async () => {
    await rememberCanvasArtefact('project-1', 'thread-1', artefact({ preview: PREVIEW }))

    assert.deepEqual(await loadCanvasArtefactSummaries('project-1', 'thread-1'), [
      { title: 'Sales Dashboard', preview: PREVIEW },
    ])
    const restored = await readStoredCanvasArtefact('project-1', 'thread-1', 'Sales Dashboard')
    assert.ok(restored, 'the artefact is still there')
    assert.equal(restored.body, '<!doctype html><h1>v1</h1>')
    assert.equal(restored.mimeType, 'text/html')
    assert.equal(restored.threadId, 'thread-1')
  })

  it('keeps one record per title, holding the newest render', async () => {
    await rememberCanvasArtefact('project-1', 'thread-1', artefact())
    await rememberCanvasArtefact(
      'project-1',
      'thread-1',
      artefact({ body: '<!doctype html><h1>v2</h1>' }),
    )

    const summaries = await loadCanvasArtefactSummaries('project-1', 'thread-1')
    assert.equal(summaries.length, 1)
    const restored = await readStoredCanvasArtefact('project-1', 'thread-1', 'Sales Dashboard')
    assert.equal(restored?.body, '<!doctype html><h1>v2</h1>')
  })

  it('scopes artefacts to their own thread', async () => {
    await rememberCanvasArtefact('project-1', 'thread-1', artefact())

    assert.deepEqual(await loadCanvasArtefactSummaries('project-1', 'thread-2'), [])
    assert.equal(await readStoredCanvasArtefact('project-1', 'thread-2', 'Sales Dashboard'), null)
  })

  it('returns null for a title the thread never rendered', async () => {
    await rememberCanvasArtefact('project-1', 'thread-1', artefact())

    assert.equal(await readStoredCanvasArtefact('project-1', 'thread-1', 'Other'), null)
  })

  it('prefers the workspace file it was rendered from, so later edits show', async () => {
    await writeFile(join(workspace, 'demo.html'), '<!doctype html><h1>original</h1>')
    await rememberCanvasArtefact(
      'project-1',
      'thread-1',
      artefact({ body: '<!doctype html><h1>original</h1>', sourcePath: 'demo.html' }),
    )

    await writeFile(join(workspace, 'demo.html'), '<!doctype html><h1>edited</h1>')
    const restored = await readStoredCanvasArtefact('project-1', 'thread-1', 'Sales Dashboard')
    assert.ok(restored)
    assert.equal(restored.body, '<!doctype html><h1>edited</h1>')
    assert.equal(restored.sourcePath, 'demo.html')
  })

  it('falls back to its own snapshot when the source file is gone', async () => {
    await writeFile(join(workspace, 'demo.html'), '<!doctype html><h1>original</h1>')
    await rememberCanvasArtefact(
      'project-1',
      'thread-1',
      artefact({ body: '<!doctype html><h1>original</h1>', sourcePath: 'demo.html' }),
    )

    await rm(join(workspace, 'demo.html'))
    const restored = await readStoredCanvasArtefact('project-1', 'thread-1', 'Sales Dashboard')
    assert.equal(restored?.body, '<!doctype html><h1>original</h1>')
  })

  it('ignores the source path when a different workspace is open', async () => {
    await writeFile(join(workspace, 'demo.html'), '<!doctype html><h1>project one</h1>')
    await rememberCanvasArtefact(
      'project-1',
      'thread-1',
      artefact({ body: '<!doctype html><h1>project one</h1>', sourcePath: 'demo.html' }),
    )

    // Same relative path, different project: reading it would render a stranger's
    // file under project-1's artefact title.
    const other = await mkdtemp(join(tmpdir(), 'canvas-workspace-'))
    await writeFile(join(other, 'demo.html'), '<!doctype html><h1>project two</h1>')
    const restore = setWorkspaceRootForTest(other)
    try {
      const restored = await readStoredCanvasArtefact('project-1', 'thread-1', 'Sales Dashboard')
      assert.equal(restored?.body, '<!doctype html><h1>project one</h1>')
    } finally {
      restore()
      await rm(other, { recursive: true, force: true })
    }
  })

  it('stores an artefact with no thumbnail, and still reopens it', async () => {
    await rememberCanvasArtefact('project-1', 'thread-1', artefact())

    assert.deepEqual(await loadCanvasArtefactSummaries('project-1', 'thread-1'), [
      { title: 'Sales Dashboard' },
    ])
    const restored = await readStoredCanvasArtefact('project-1', 'thread-1', 'Sales Dashboard')
    assert.ok(restored)
    assert.equal(restored.body, '<!doctype html><h1>v1</h1>')
    assert.equal(restored.preview, undefined)
  })

  it('writes the artefact as a readable file beside the transcript', async () => {
    await rememberCanvasArtefact('project-1', 'thread-1', artefact())

    const index = safeJsonParse(
      await readFile(join(store, 'project-1', 'thread-1', 'canvas', 'index.json'), 'utf8'),
      decodeWithSchema(z.object({ artefacts: z.array(z.object({ bodyFile: z.string() })) })),
    )
    assert.ok(index, 'the index is readable JSON in the shape the store writes')
    const [record] = index.artefacts
    assert.ok(record, 'expected one indexed artefact')
    assert.match(record.bodyFile, /\.html$/)
    assert.equal(
      await readFile(join(store, 'project-1', 'thread-1', 'canvas', record.bodyFile), 'utf8'),
      '<!doctype html><h1>v1</h1>',
    )
  })

  it('drops the oldest artefacts once a thread has rendered too many titles', async () => {
    for (let i = 0; i < 55; i++) {
      await rememberCanvasArtefact(
        'project-1',
        'thread-1',
        artefact({ title: `Artefact ${String(i)}` }),
      )
    }

    const summaries = await loadCanvasArtefactSummaries('project-1', 'thread-1')
    assert.equal(summaries.length, 20, 'hydration reads the most recent window')
    assert.equal(summaries.at(-1)?.title, 'Artefact 54')
    assert.equal(await readStoredCanvasArtefact('project-1', 'thread-1', 'Artefact 0'), null)
    assert.ok(await readStoredCanvasArtefact('project-1', 'thread-1', 'Artefact 54'))
  })
})
