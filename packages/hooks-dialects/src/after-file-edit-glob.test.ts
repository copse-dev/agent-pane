import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { afterFileEditGlobMatches, createRecentKeySet } from './after-file-edit-glob.ts'

describe('afterFileEditGlobMatches', () => {
  const root = '/work/repo'

  it('fires for every edit when the hook has no glob', () => {
    assert.equal(afterFileEditGlobMatches(undefined, '/work/repo/a.md', root), true)
    assert.equal(afterFileEditGlobMatches([], '/work/repo/a.md', root), true)
  })

  it('matches the absolute, workspace-relative and basename forms', () => {
    assert.equal(afterFileEditGlobMatches(['src/**'], '/work/repo/src/a/b.ts', root), true)
    assert.equal(afterFileEditGlobMatches(['*.ts'], '/work/repo/src/a/b.ts', root), true)
    assert.equal(afterFileEditGlobMatches(['/work/**/*.ts'], '/work/repo/b.ts', null), true)
    assert.equal(afterFileEditGlobMatches(['*.md', '*.css'], '/work/repo/src/b.ts', root), false)
    // Outside the workspace only the absolute path and basename are tried.
    assert.equal(afterFileEditGlobMatches(['src/**'], '/elsewhere/src/b.ts', root), false)
  })

  // GHSA-fc5q-39xc-vjpf: a hooks.json glob such as `+(*a)` compiles to nested
  // quantifiers and would freeze the main process on every matching-shaped edit.
  it('treats a backtracking glob as a match instead of hanging, and does not re-run it', () => {
    const edited = `/work/repo/src/${'a'.repeat(48)}!`
    const started = Date.now()
    assert.equal(afterFileEditGlobMatches(['+(*a)'], edited, root), true)
    const firstMs = Date.now() - started
    assert.ok(firstMs < 5_000, `first match took ${String(firstMs)}ms`)
    const again = Date.now()
    assert.equal(afterFileEditGlobMatches(['+(*a)'], '/work/repo/x.ts', root), true)
    assert.ok(Date.now() - again < 40, 'a pathological glob list is remembered')
  })

  // picomatch throws for a glob longer than 65,536 characters; the throw used to
  // leave the adapter's filter and drop every afterFileEdit hook for the edit.
  it('treats a glob picomatch refuses as matching nothing, without throwing', () => {
    const oversized = 'a'.repeat(65_537)
    assert.equal(afterFileEditGlobMatches([oversized], '/work/repo/src/b.ts', root), false)
    assert.equal(afterFileEditGlobMatches([oversized, '*.ts'], '/work/repo/src/b.ts', root), true)
    assert.equal(afterFileEditGlobMatches([oversized, '*.md'], '/work/repo/src/b.ts', root), false)
  })
})

describe('createRecentKeySet', () => {
  // Every workspace's hooks.json can add timed-out glob lists, so the set the
  // matcher remembers them in must not grow for the life of the app.
  it('keeps at most max keys, forgetting the oldest first', () => {
    const keys = createRecentKeySet(2)
    keys.add('a')
    keys.add('b')
    keys.add('a')
    keys.add('c')
    assert.equal(keys.has('a'), false)
    assert.equal(keys.has('b'), true)
    assert.equal(keys.has('c'), true)
  })
})
