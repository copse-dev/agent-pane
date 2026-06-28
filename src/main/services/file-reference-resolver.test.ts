import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveFileReferences } from './file-reference-resolver.ts'
import { invalidateIndex, setIndexForTest } from './file-index.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('file-reference-resolver', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-file-ref-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    setIndexForTest([
      'README.md',
      'src/renderer/markdown/renderer.ts',
      'src/main/index.ts',
      'tests/renderer.test.ts',
      'src/renderer/renderer.test.ts',
      'scripts/build.mts',
    ])
  })

  afterEach(() => {
    restoreWorkspace?.()
    invalidateIndex()
    void rm(tempRoot, { recursive: true, force: true })
  })

  it('resolves exact workspace-relative paths', () => {
    assert.deepEqual(resolveFileReferences(['src/main/index.ts']), [
      { candidate: 'src/main/index.ts', path: 'src/main/index.ts', kind: 'file' },
    ])
  })

  it('resolves bare filenames only when the basename is unique', () => {
    assert.deepEqual(resolveFileReferences(['renderer.ts', 'index.ts']), [
      { candidate: 'renderer.ts', path: 'src/renderer/markdown/renderer.ts', kind: 'file' },
      { candidate: 'index.ts', path: 'src/main/index.ts', kind: 'file' },
    ])
  })

  it('does not resolve ambiguous basenames', () => {
    assert.deepEqual(resolveFileReferences(['renderer.test.ts']), [])
  })

  it('rejects absolute and parent-relative candidates', () => {
    assert.deepEqual(resolveFileReferences(['/workspace/README.md', '../README.md']), [])
  })

  it('normalizes leading dot-slash exact paths', () => {
    assert.deepEqual(resolveFileReferences(['./scripts/build.mts']), [
      { candidate: './scripts/build.mts', path: 'scripts/build.mts', kind: 'file' },
    ])
  })

  it('resolves gitignored and unindexed files that exist on disk', async () => {
    await writeFile(join(tempRoot, 'DEVELOPMENT-NOTES.md'), '# notes\n', 'utf-8')
    assert.deepEqual(resolveFileReferences(['DEVELOPMENT-NOTES.md']), [
      { candidate: 'DEVELOPMENT-NOTES.md', path: 'DEVELOPMENT-NOTES.md', kind: 'file' },
    ])
  })

  it('resolves workspace directories that are not in the file index', async () => {
    await mkdir(join(tempRoot, 'src', 'renderer', 'views'), { recursive: true })
    assert.deepEqual(resolveFileReferences(['src/renderer/views']), [
      { candidate: 'src/renderer/views', path: 'src/renderer/views', kind: 'directory' },
    ])
  })
})
