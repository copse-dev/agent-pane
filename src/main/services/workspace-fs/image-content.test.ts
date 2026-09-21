import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readWorkspaceImage, MAX_WORKSPACE_IMAGE_BYTES } from './image-content.ts'
import { localWorkspaceFs } from './local-workspace-fs.ts'
import { WorkspaceFileTooLargeError } from './workspace-fs.ts'

describe('workspace image content', () => {
  let root = ''
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('preserves non-UTF8 bytes and uses the requested image extension for a resolved target', async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-image-preview-'))
    const path = join(root, 'opaque-target')
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 0, 255, 128])
    await writeFile(path, bytes)
    assert.equal(
      await readWorkspaceImage(localWorkspaceFs, path, 'linked.PNG'),
      `data:image/png;base64,${bytes.toString('base64')}`,
    )
  })

  it('rejects unsupported formats before touching the filesystem', async () => {
    await assert.rejects(
      readWorkspaceImage(localWorkspaceFs, '/does-not-exist', 'page.html'),
      /not a supported image/,
    )
  })

  it('rejects oversized local images before transferring their bytes', async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-image-preview-'))
    const path = join(root, 'large.png')
    await writeFile(path, '')
    await truncate(path, MAX_WORKSPACE_IMAGE_BYTES + 1)
    await assert.rejects(
      readWorkspaceImage(localWorkspaceFs, path, 'large.png'),
      WorkspaceFileTooLargeError,
    )
  })

  it('passes the same bound to a remote filesystem and rejects growth after its size check', async () => {
    const fs = {
      ...localWorkspaceFs,
      readFileBytes: async (path: string, options?: { maxBytes?: number }): Promise<Buffer> => {
        assert.equal(path, '/remote/chart.png')
        assert.equal(options?.maxBytes, MAX_WORKSPACE_IMAGE_BYTES)
        return Buffer.alloc(MAX_WORKSPACE_IMAGE_BYTES + 1)
      },
    }
    await assert.rejects(
      readWorkspaceImage(fs, '/remote/chart.png', 'chart.png'),
      WorkspaceFileTooLargeError,
    )
  })
})
