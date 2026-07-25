import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MAX_VIDEO_BYTES } from '@shared/video/video-media.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { describeWorkspaceVideo, storeVideoAttachment } from './video-attachment-store.ts'

const BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])

describe('video attachment store', () => {
  let workspaceRoot = ''
  let restoreWorkspace: (() => void) | undefined
  let previousWorkspaceDir: string | undefined
  let storeRoot = ''

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'copse-panel-video-ws-'))
    storeRoot = await mkdtemp(join(tmpdir(), 'copse-panel-video-store-'))
    previousWorkspaceDir = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = storeRoot
    restoreWorkspace = setWorkspaceRootForTest(workspaceRoot)
  })

  afterEach(async () => {
    restoreWorkspace?.()
    restoreWorkspace = undefined
    if (previousWorkspaceDir === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousWorkspaceDir
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(storeRoot, { recursive: true, force: true })
  })

  it('writes a dropped video into the thread and reports where', async () => {
    const ref = storeVideoAttachment('proj', 'thread-1', {
      name: 'Screen Recording.mov',
      mimeType: 'video/quicktime',
      bytes: BYTES,
    })
    assert.equal(ref.name, 'Screen Recording.mov')
    assert.equal(ref.sizeBytes, BYTES.byteLength)
    assert.equal(ref.mimeType, 'video/quicktime')
    // Inside the thread's own blobs dir, so the agent's read tools can open it.
    assert.ok(ref.path.includes(join('proj', 'thread-1', 'blobs', 'media')))
    assert.deepEqual(new Uint8Array(await readFile(ref.path)), BYTES)
  })

  it('keeps the original name legible but strips anything path-like', () => {
    const ref = storeVideoAttachment('proj', 'thread-1', {
      name: '../../etc/pwned demo.mp4',
      mimeType: 'video/mp4',
      bytes: BYTES,
    })
    assert.ok(!ref.path.includes('..'))
    assert.ok(ref.path.includes('etc-pwned-demo.mp4'))
    assert.ok(ref.path.includes(join('thread-1', 'blobs', 'media')))
  })

  it('gives two drops of the same filename distinct paths', () => {
    const first = storeVideoAttachment('proj', 't', {
      name: 'demo.mp4',
      mimeType: 'video/mp4',
      bytes: BYTES,
    })
    const second = storeVideoAttachment('proj', 't', {
      name: 'demo.mp4',
      mimeType: 'video/mp4',
      bytes: BYTES,
    })
    assert.notEqual(first.path, second.path)
  })

  it('rejects unsupported, empty and oversized files', () => {
    assert.throws(
      () =>
        storeVideoAttachment('proj', 't', {
          name: 'notes.txt',
          mimeType: 'text/plain',
          bytes: BYTES,
        }),
      /not a supported video/,
    )
    assert.throws(
      () =>
        storeVideoAttachment('proj', 't', {
          name: 'demo.mp4',
          mimeType: 'video/mp4',
          bytes: new Uint8Array(0),
        }),
      /is empty/,
    )
    assert.throws(
      () =>
        storeVideoAttachment('proj', 't', {
          name: 'demo.mp4',
          mimeType: 'video/mp4',
          // Only the length is read before the limit check rejects it.
          bytes: { byteLength: MAX_VIDEO_BYTES + 1 } as unknown as Uint8Array,
        }),
      /over the .* limit/,
    )
  })

  describe('describeWorkspaceVideo', () => {
    it('references a workspace video in place instead of copying it', async () => {
      await writeFile(join(workspaceRoot, 'demo.mp4'), Buffer.from(BYTES))
      const ref = await describeWorkspaceVideo('demo.mp4', 'demo.mp4', 'video/mp4')
      assert.equal(ref.path, join(workspaceRoot, 'demo.mp4'))
      assert.equal(ref.sizeBytes, BYTES.byteLength)
    })

    it('refuses a path outside the workspace', async () => {
      await assert.rejects(() => describeWorkspaceVideo('../outside.mp4', 'outside.mp4', ''))
    })

    it('refuses a non-video extension', async () => {
      await assert.rejects(
        () => describeWorkspaceVideo('notes.txt', 'notes.txt', 'text/plain'),
        /not a supported video/,
      )
    })
  })
})
