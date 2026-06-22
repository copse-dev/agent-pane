import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFileReferences } from './file-reference-resolver.ts'
import { invalidateIndex, setIndexForTest } from './file-index.ts'

describe('file-reference-resolver', () => {
  beforeEach(() => {
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
    invalidateIndex()
  })

  it('resolves exact workspace-relative paths', () => {
    assert.deepEqual(resolveFileReferences(['src/main/index.ts']), [
      { candidate: 'src/main/index.ts', path: 'src/main/index.ts' },
    ])
  })

  it('resolves bare filenames only when the basename is unique', () => {
    assert.deepEqual(resolveFileReferences(['renderer.ts', 'index.ts']), [
      { candidate: 'renderer.ts', path: 'src/renderer/markdown/renderer.ts' },
      { candidate: 'index.ts', path: 'src/main/index.ts' },
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
      { candidate: './scripts/build.mts', path: 'scripts/build.mts' },
    ])
  })
})
