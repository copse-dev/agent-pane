import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { MAX_INLINE_PLAYBACK_BYTES, readVideoForPlayback } from './video-attachment-store.ts'

/**
 * `readVideoForPlayback` hands renderer-supplied paths to the filesystem, so the
 * authorisation boundary is the whole point of these tests: it must reach the
 * chat store and the workspace and nothing else.
 */
describe('readVideoForPlayback', () => {
  let chatStore = ''
  let workspace = ''
  let outside = ''
  let restoreWorkspace: (() => void) | undefined
  const previousStore = process.env['COPSE_WORKSPACE_DIR']

  beforeEach(async () => {
    chatStore = await mkdtemp(join(tmpdir(), 'copse-video-store-'))
    workspace = await mkdtemp(join(tmpdir(), 'copse-video-ws-'))
    outside = await mkdtemp(join(tmpdir(), 'copse-video-out-'))
    process.env['COPSE_WORKSPACE_DIR'] = chatStore
    restoreWorkspace = setWorkspaceRootForTest(workspace)
  })

  afterEach(async () => {
    restoreWorkspace?.()
    restoreWorkspace = undefined
    if (previousStore === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousStore
    await Promise.all(
      [chatStore, workspace, outside].map((d) => rm(d, { recursive: true, force: true })),
    )
  })

  it('reads a video stored in the chat store', async () => {
    const dir = join(chatStore, 'project', 'thread', 'blobs', 'media')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'capture.mp4')
    await writeFile(path, Buffer.from('pretend mp4'))
    const played = await readVideoForPlayback(path)
    assert.equal(Buffer.from(played.bytes).toString(), 'pretend mp4')
    assert.equal(played.mimeType, 'video/mp4')
  })

  it('reads a video that lives in the workspace', async () => {
    await writeFile(join(workspace, 'demo.webm'), Buffer.from('pretend webm'))
    const played = await readVideoForPlayback('demo.webm')
    assert.equal(played.mimeType, 'video/webm')
  })

  it('refuses a path outside the chat store and the workspace', async () => {
    const path = join(outside, 'secret.mp4')
    await writeFile(path, Buffer.from('not yours'))
    await assert.rejects(() => readVideoForPlayback(path))
  })

  it('refuses a traversal out of the chat store', async () => {
    const path = join(outside, 'escape.mp4')
    await writeFile(path, Buffer.from('not yours'))
    await assert.rejects(() => readVideoForPlayback(join(chatStore, '..', '..', path)))
  })

  it('refuses a file that is not a supported video', async () => {
    const dir = join(chatStore, 'project', 'thread', 'blobs', 'media')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'notes.txt')
    await writeFile(path, Buffer.from('hello'))
    await assert.rejects(() => readVideoForPlayback(path), /not a supported video/)
  })

  it('refuses a video over the preview limit, naming the size', async () => {
    // Playback pins every byte in the visible renderer, so the preview ceiling
    // is far below the 256MB the frame extractor accepts.
    const dir = join(chatStore, 'project', 'thread', 'blobs', 'media')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'huge.mp4')
    const handle = await open(path, 'w')
    await handle.truncate(MAX_INLINE_PLAYBACK_BYTES + 1)
    await handle.close()
    await assert.rejects(() => readVideoForPlayback(path), /preview limit/)
  })

  it('maps each container to a type Chromium can play', async () => {
    const dir = join(chatStore, 'project', 'thread', 'blobs', 'media')
    await mkdir(dir, { recursive: true })
    for (const [file, expected] of [
      ['a.mp4', 'video/mp4'],
      ['a.m4v', 'video/mp4'],
      ['a.mov', 'video/quicktime'],
      ['a.webm', 'video/webm'],
      ['a.mkv', 'video/x-matroska'],
      ['a.ogv', 'video/ogg'],
    ] as const) {
      const path = join(dir, file)
      await writeFile(path, Buffer.from('x'))
      assert.equal((await readVideoForPlayback(path)).mimeType, expected, file)
    }
  })
})
