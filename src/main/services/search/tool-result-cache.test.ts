import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  getCachedToolResult,
  setCachedToolResult,
  invalidateThreadToolCache,
  invalidateToolResultCacheForChange,
  resolveToolResultScope,
  clearAllToolResultCachesForTest,
  type ToolCacheIdentity,
} from './tool-result-cache.ts'

const ROOT = '/projects/app'
const WORKTREE = '/home/u/.copse/worktrees/p1/t2'

function identity(threadId: string, overrides: Partial<ToolCacheIdentity> = {}): ToolCacheIdentity {
  return { threadId, root: ROOT, branch: 'main', ...overrides }
}

describe('tool-result-cache', () => {
  beforeEach(() => {
    clearAllToolResultCachesForTest()
  })

  describe('identity', () => {
    it('returns undefined on a miss and the stored result on a hit', () => {
      assert.equal(
        getCachedToolResult(identity('t1'), 'search_code', { pattern: 'foo' }),
        undefined,
      )
      setCachedToolResult(identity('t1'), 'search_code', { pattern: 'foo' }, 'result-a')
      assert.equal(
        getCachedToolResult(identity('t1'), 'search_code', { pattern: 'foo' }),
        'result-a',
      )
    })

    it('is insensitive to argument key order', () => {
      setCachedToolResult(identity('t1'), 'search_code', { a: 1, b: 2 }, 'r')
      assert.equal(getCachedToolResult(identity('t1'), 'search_code', { b: 2, a: 1 }), 'r')
    })

    it('treats different tool names or args as distinct entries', () => {
      setCachedToolResult(identity('t1'), 'find_files', { pattern: '*.ts' }, 'ts-files')
      assert.equal(
        getCachedToolResult(identity('t1'), 'find_files', { pattern: '*.js' }),
        undefined,
      )
      assert.equal(getCachedToolResult(identity('t1'), 'list_dir', { pattern: '*.ts' }), undefined)
    })

    it('never shares entries between threads', () => {
      setCachedToolResult(identity('t1'), 'find_files', { pattern: '*.ts' }, 'from-t1')
      assert.equal(
        getCachedToolResult(identity('t2'), 'find_files', { pattern: '*.ts' }),
        undefined,
      )
      assert.equal(
        getCachedToolResult(identity('t1'), 'find_files', { pattern: '*.ts' }),
        'from-t1',
      )
    })

    // Two threads on separate worktrees of one project must not see each
    // other's results even though the tool and args are identical.
    it('keeps worktree threads isolated from shared-checkout threads', () => {
      setCachedToolResult(identity('shared'), 'search_code', { pattern: 'x' }, 'project-result')
      setCachedToolResult(
        identity('wt', { root: WORKTREE }),
        'search_code',
        { pattern: 'x' },
        'worktree-result',
      )
      assert.equal(
        getCachedToolResult(identity('shared'), 'search_code', { pattern: 'x' }),
        'project-result',
      )
      assert.equal(
        getCachedToolResult(identity('wt', { root: WORKTREE }), 'search_code', { pattern: 'x' }),
        'worktree-result',
      )
    })

    it('treats a changed root for the same thread as a miss', () => {
      setCachedToolResult(identity('t1'), 'find_files', {}, 'old')
      assert.equal(
        getCachedToolResult(identity('t1', { root: WORKTREE }), 'find_files', {}),
        undefined,
      )
    })

    it('never serves results from another branch', () => {
      setCachedToolResult(
        identity('t1', { branch: 'main' }),
        'search_code',
        { pattern: 'x' },
        'on-main',
      )
      assert.equal(
        getCachedToolResult(identity('t1', { branch: 'feature' }), 'search_code', { pattern: 'x' }),
        undefined,
      )
    })

    it('does not confuse a detached HEAD (null branch) with a named branch', () => {
      setCachedToolResult(
        identity('t1', { branch: null }),
        'search_code',
        { pattern: 'x' },
        'detached',
      )
      assert.equal(
        getCachedToolResult(identity('t1', { branch: 'main' }), 'search_code', { pattern: 'x' }),
        undefined,
      )
      assert.equal(
        getCachedToolResult(identity('t1', { branch: null }), 'search_code', { pattern: 'x' }),
        'detached',
      )
    })

    it('replaces a stale-branch bucket rather than accumulating both', () => {
      setCachedToolResult(identity('t1', { branch: 'main' }), 'search_code', { pattern: 'x' }, 'a')
      setCachedToolResult(
        identity('t1', { branch: 'feature' }),
        'search_code',
        { pattern: 'x' },
        'b',
      )
      // Switching back must not resurrect the pre-switch result.
      assert.equal(
        getCachedToolResult(identity('t1', { branch: 'main' }), 'search_code', { pattern: 'x' }),
        undefined,
      )
    })
  })

  describe('scope resolution', () => {
    it('falls back to the root when there is no path argument', () => {
      assert.equal(resolveToolResultScope(ROOT, { pattern: 'x' }), ROOT)
      assert.equal(resolveToolResultScope(ROOT, {}), ROOT)
      assert.equal(resolveToolResultScope(ROOT, undefined), ROOT)
    })

    it('treats "." and empty string as the root', () => {
      assert.equal(resolveToolResultScope(ROOT, { path: '.' }), ROOT)
      assert.equal(resolveToolResultScope(ROOT, { path: '' }), ROOT)
    })

    it('resolves a relative path against the root', () => {
      assert.equal(resolveToolResultScope(ROOT, { path: 'src' }), join(ROOT, 'src'))
      assert.equal(resolveToolResultScope(ROOT, { path: 'src/main' }), join(ROOT, 'src', 'main'))
    })

    // A path outside the root (the read-only chat store) can't be reasoned
    // about from workspace edits, so it must degrade to the conservative root.
    it('falls back to the root for a path that escapes it', () => {
      assert.equal(resolveToolResultScope(ROOT, { path: '../elsewhere' }), ROOT)
      assert.equal(resolveToolResultScope(ROOT, { path: '/etc' }), ROOT)
    })
  })

  describe('invalidation', () => {
    it('invalidateThreadToolCache clears only that thread', () => {
      setCachedToolResult(identity('t1'), 'find_files', {}, 'a')
      setCachedToolResult(identity('t2'), 'find_files', {}, 'b')
      invalidateThreadToolCache('t1')
      assert.equal(getCachedToolResult(identity('t1'), 'find_files', {}), undefined)
      assert.equal(getCachedToolResult(identity('t2'), 'find_files', {}), 'b')
    })

    it('leaves entries scoped to an untouched directory alone', () => {
      setCachedToolResult(identity('t1'), 'search_code', { path: 'docs' }, 'docs-hits')
      setCachedToolResult(identity('t1'), 'search_code', { path: 'src' }, 'src-hits')
      invalidateToolResultCacheForChange(ROOT, join(ROOT, 'src', 'main.ts'))
      assert.equal(getCachedToolResult(identity('t1'), 'search_code', { path: 'src' }), undefined)
      assert.equal(
        getCachedToolResult(identity('t1'), 'search_code', { path: 'docs' }),
        'docs-hits',
      )
    })

    it('invalidates root-scoped entries for a change anywhere under the root', () => {
      setCachedToolResult(identity('t1'), 'find_files', { pattern: '*.ts' }, 'all')
      invalidateToolResultCacheForChange(ROOT, join(ROOT, 'docs', 'readme.md'))
      assert.equal(
        getCachedToolResult(identity('t1'), 'find_files', { pattern: '*.ts' }),
        undefined,
      )
    })

    it('invalidates a parent scope when a nested file changes', () => {
      setCachedToolResult(identity('t1'), 'search_code', { path: 'src' }, 'hits')
      invalidateToolResultCacheForChange(ROOT, join(ROOT, 'src', 'deep', 'nested', 'file.ts'))
      assert.equal(getCachedToolResult(identity('t1'), 'search_code', { path: 'src' }), undefined)
    })

    it('does not treat a sibling directory sharing a name prefix as nested', () => {
      setCachedToolResult(identity('t1'), 'search_code', { path: 'src' }, 'hits')
      invalidateToolResultCacheForChange(ROOT, join(ROOT, 'src-generated', 'file.ts'))
      assert.equal(getCachedToolResult(identity('t1'), 'search_code', { path: 'src' }), 'hits')
    })

    it('drops everything under the root when the change cannot be located', () => {
      setCachedToolResult(identity('t1'), 'search_code', { path: 'docs' }, 'docs-hits')
      invalidateToolResultCacheForChange(ROOT, null)
      assert.equal(getCachedToolResult(identity('t1'), 'search_code', { path: 'docs' }), undefined)
    })

    it('leaves a worktree thread untouched by a change in the project it branched from', () => {
      setCachedToolResult(identity('t1', { root: WORKTREE }), 'find_files', {}, 'wt')
      invalidateToolResultCacheForChange(ROOT, join(ROOT, 'src', 'main.ts'))
      assert.equal(getCachedToolResult(identity('t1', { root: WORKTREE }), 'find_files', {}), 'wt')
    })

    it('invalidates a thread rooted in a subdirectory of the changed root', () => {
      const nested = join(ROOT, 'packages', 'web')
      setCachedToolResult(identity('t1', { root: nested }), 'find_files', {}, 'nested')
      invalidateToolResultCacheForChange(ROOT, join(nested, 'index.ts'))
      assert.equal(
        getCachedToolResult(identity('t1', { root: nested }), 'find_files', {}),
        undefined,
      )
    })

    it('does not treat a sibling root sharing a name prefix as a descendant', () => {
      setCachedToolResult(identity('t1', { root: `${ROOT}-backup` }), 'find_files', {}, 'a')
      invalidateToolResultCacheForChange(ROOT, null)
      assert.equal(
        getCachedToolResult(identity('t1', { root: `${ROOT}-backup` }), 'find_files', {}),
        'a',
      )
    })
  })

  describe('bounds', () => {
    it('evicts the oldest entry once a thread exceeds its entry cap', () => {
      for (let i = 0; i < 201; i++) {
        setCachedToolResult(identity('t1'), 'find_files', { i }, `r${String(i)}`)
      }
      assert.equal(getCachedToolResult(identity('t1'), 'find_files', { i: 0 }), undefined)
      assert.equal(getCachedToolResult(identity('t1'), 'find_files', { i: 200 }), 'r200')
    })

    it('bounds how many threads are retained, evicting least-recently-used', () => {
      for (let i = 0; i < 9; i++) {
        setCachedToolResult(identity(`t${String(i)}`), 'find_files', {}, `r${String(i)}`)
      }
      assert.equal(getCachedToolResult(identity('t0'), 'find_files', {}), undefined)
      assert.equal(getCachedToolResult(identity('t8'), 'find_files', {}), 'r8')
    })
  })
})
