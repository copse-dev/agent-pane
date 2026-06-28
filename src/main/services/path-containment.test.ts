import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPathInsideRoot, resolveWithinRoot } from './path-containment.ts'

describe('isPathInsideRoot', () => {
  it('accepts the root itself and nested paths', () => {
    assert.equal(isPathInsideRoot('/work', '/work'), true)
    assert.equal(isPathInsideRoot('/work/src/a.ts', '/work'), true)
  })

  it('rejects siblings, parents, and prefix-collisions', () => {
    assert.equal(isPathInsideRoot('/work2', '/work'), false)
    assert.equal(isPathInsideRoot('/workshop/a', '/work'), false)
    assert.equal(isPathInsideRoot('/other', '/work'), false)
  })
})

describe('resolveWithinRoot', () => {
  let root: string
  let outside: string

  before(() => {
    // realpath so comparisons hold on platforms with symlinked temp dirs (macOS).
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-root-')))
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'pc-out-')))
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'file.txt'), 'hi')
    writeFileSync(join(outside, 'secret.txt'), 'nope')
  })

  after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('resolves a relative path against the root', () => {
    assert.equal(resolveWithinRoot('sub/file.txt', root), join(root, 'sub', 'file.txt'))
  })

  it('resolves an absolute path inside the root', () => {
    const abs = join(root, 'sub', 'file.txt')
    assert.equal(resolveWithinRoot(abs, root), abs)
  })

  it('returns null for traversal escapes', () => {
    assert.equal(resolveWithinRoot('../escape', root), null)
    assert.equal(resolveWithinRoot('sub/../../escape', root), null)
  })

  it('returns null for an absolute path outside the root', () => {
    assert.equal(resolveWithinRoot(join(outside, 'secret.txt'), root), null)
  })

  it('returns null when a symlink inside the root escapes it', () => {
    symlinkSync(outside, join(root, 'link'))
    // The link resolves (via realpath) to a path outside the root → rejected.
    assert.equal(resolveWithinRoot(join(root, 'link', 'secret.txt'), root), null)
    assert.equal(resolveWithinRoot('link/secret.txt', root), null)
  })

  it('returns null when the root does not exist', () => {
    assert.equal(resolveWithinRoot('x', join(outside, 'does-not-exist')), null)
  })
})
