import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureExecutionRootWatched,
  stopWatchingExecutionRoot,
  stopAllExecutionRootWatchers,
  watchedExecutionRootsForTest,
} from './execution-root-watcher.ts'
import {
  getCachedToolResult,
  setCachedToolResult,
  clearAllToolResultCachesForTest,
} from './tool-result-cache.ts'

/** fs.watch is asynchronous; poll rather than guess a fixed delay. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

describe('execution-root-watcher', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-exec-watch-'))
    clearAllToolResultCachesForTest()
  })

  afterEach(async () => {
    stopAllExecutionRootWatchers()
    clearAllToolResultCachesForTest()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('watches a root once, idempotently', () => {
    assert.equal(ensureExecutionRootWatched(root), true)
    assert.equal(ensureExecutionRootWatched(root), true)
    assert.deepEqual(watchedExecutionRootsForTest(), [root])
  })

  it('reports failure for a root that cannot be watched', () => {
    assert.equal(ensureExecutionRootWatched(join(root, 'does-not-exist')), false)
    assert.deepEqual(watchedExecutionRootsForTest(), [])
  })

  it('invalidates cached results when a file under the root changes', async () => {
    ensureExecutionRootWatched(root)
    setCachedToolResult(
      { threadId: 't1', root, branch: 'main' },
      'search_code',
      { pattern: 'foo' },
      'stale',
    )
    await writeFile(join(root, 'touched.ts'), 'export const a = 1\n')
    const cleared = await waitFor(
      () =>
        getCachedToolResult({ threadId: 't1', root, branch: 'main' }, 'search_code', {
          pattern: 'foo',
        }) === undefined,
    )
    assert.ok(cleared, 'expected the external write to drop the cached result')
  })

  it('ignores churn under ignored directories', async () => {
    ensureExecutionRootWatched(root)
    setCachedToolResult(
      { threadId: 't1', root, branch: 'main' },
      'search_code',
      { pattern: 'foo' },
      'kept',
    )
    await writeFile(join(root, 'node_modules'), 'not a real dep tree\n')
    // Give any event the same window the positive case gets before asserting.
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(
      getCachedToolResult({ threadId: 't1', root, branch: 'main' }, 'search_code', {
        pattern: 'foo',
      }),
      'kept',
    )
  })

  // Directory awareness end-to-end: a real write under src/ must clear the
  // src-scoped entry and spare the docs-scoped one.
  it('only invalidates entries whose scope contains the changed file', async () => {
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'docs'), { recursive: true })
    ensureExecutionRootWatched(root)
    const id = { threadId: 't1', root, branch: 'main' }
    setCachedToolResult(id, 'search_code', { path: 'src' }, 'src-hits')
    setCachedToolResult(id, 'search_code', { path: 'docs' }, 'docs-hits')

    await writeFile(join(root, 'src', 'main.ts'), 'export const a = 1\n')
    const cleared = await waitFor(
      () => getCachedToolResult(id, 'search_code', { path: 'src' }) === undefined,
    )
    assert.ok(cleared, 'expected the src-scoped result to be dropped')
    assert.equal(
      getCachedToolResult(id, 'search_code', { path: 'docs' }),
      'docs-hits',
      'a write under src/ must not disturb a docs-scoped result',
    )
  })

  // A terminal-side `git checkout` moves .git/HEAD, which the dotfile ignore
  // rule would otherwise swallow.
  it('treats a moved branch pointer as invalidating the whole root', async () => {
    await mkdir(join(root, '.git'), { recursive: true })
    ensureExecutionRootWatched(root)
    const id = { threadId: 't1', root, branch: 'main' }
    setCachedToolResult(id, 'search_code', { path: 'docs' }, 'docs-hits')

    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/feature\n')
    const cleared = await waitFor(
      () => getCachedToolResult(id, 'search_code', { path: 'docs' }) === undefined,
    )
    assert.ok(cleared, 'expected a HEAD move to drop results outside the changed directory')
  })

  it('still ignores other .git churn', async () => {
    await mkdir(join(root, '.git'), { recursive: true })
    ensureExecutionRootWatched(root)
    const id = { threadId: 't1', root, branch: 'main' }
    setCachedToolResult(id, 'search_code', { path: 'docs' }, 'docs-hits')

    await writeFile(join(root, '.git', 'COMMIT_EDITMSG'), 'wip\n')
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(getCachedToolResult(id, 'search_code', { path: 'docs' }), 'docs-hits')
  })

  it('stops delivering invalidations once the root is unwatched', async () => {
    ensureExecutionRootWatched(root)
    stopWatchingExecutionRoot(root)
    assert.deepEqual(watchedExecutionRootsForTest(), [])
    setCachedToolResult(
      { threadId: 't1', root, branch: 'main' },
      'search_code',
      { pattern: 'foo' },
      'kept',
    )
    await writeFile(join(root, 'touched.ts'), 'export const a = 1\n')
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(
      getCachedToolResult({ threadId: 't1', root, branch: 'main' }, 'search_code', {
        pattern: 'foo',
      }),
      'kept',
    )
  })
})
