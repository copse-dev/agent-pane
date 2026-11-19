import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDepRoot } from './resolve-dep.mts'

describe('resolveDepRoot', () => {
  it('resolves a package that exports its own package.json', () => {
    const root = resolveDepRoot('electron')
    assert.ok(existsSync(join(root, 'package.json')))
  })

  /**
   * `@copse/streaming-markdown`'s "exports" map omits `./package.json`, so the
   * subpath lookup throws ERR_PACKAGE_PATH_NOT_EXPORTED and only the walk-up
   * from its entry point finds the root. Most ESM-only packages ship that way.
   */
  it('resolves a package whose exports map omits ./package.json', () => {
    const root = resolveDepRoot('@copse/streaming-markdown')
    assert.ok(existsSync(join(root, 'package.json')))
    assert.ok(existsSync(join(root, 'dist')))
  })

  it('throws for a package that is not installed', () => {
    assert.throws(() => resolveDepRoot('not-a-real-package-nobody-published'))
  })
})
