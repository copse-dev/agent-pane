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
   * `@electron/rebuild` is ESM-only and its "exports" map is a bare string, so
   * neither `<pkg>/package.json` nor any other subpath resolves — the entry
   * point is the only reachable specifier. postinstall needs its CLI path, so
   * the walk-up fallback is the only thing keeping the native rebuild working.
   */
  it('resolves a package whose exports map omits ./package.json', () => {
    const root = resolveDepRoot('@electron/rebuild')
    assert.ok(existsSync(join(root, 'package.json')))
    assert.ok(existsSync(join(root, 'lib', 'cli.js')))
  })

  it('throws for a package that is not installed', () => {
    assert.throws(() => resolveDepRoot('not-a-real-package-nobody-published'))
  })
})
