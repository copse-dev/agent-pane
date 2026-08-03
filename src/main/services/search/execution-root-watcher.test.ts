import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureExecutionRootWatched,
  handleExecutionRootEvent,
  stopWatchingExecutionRoot,
  stopAllExecutionRootWatchers,
  watchedExecutionRootsForTest,
} from './execution-root-watcher.ts'
import {
  getCachedToolResult,
  setCachedToolResult,
  clearAllToolResultCachesForTest,
  type ToolCacheIdentity,
} from './tool-result-cache.ts'

const BRANCH = 'main'

function identity(root: string, threadId = 't1'): ToolCacheIdentity {
  return { threadId, root, branch: BRANCH }
}

/** fs.watch is asynchronous; poll rather than guess a fixed delay. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

/**
 * Whether this platform actually delivers recursive fs.watch events.
 *
 * Node defers the recursive setup, so `fs.watch` can return a watcher that
 * never fires under a container's inotify limits. The event *mapping* is
 * covered deterministically via {@link handleExecutionRootEvent}; the one test
 * below that needs real delivery skips rather than fails where the OS won't
 * cooperate, since that is an environment property, not a defect.
 */
async function detectFsEventDelivery(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'copse-probe-'))
  let fired = false
  let watcher: fs.FSWatcher | undefined
  try {
    watcher = fs.watch(dir, { recursive: true, persistent: false }, () => {
      fired = true
    })
  } catch {
    await rm(dir, { recursive: true, force: true })
    return false
  }
  try {
    await writeFile(join(dir, 'probe.txt'), 'probe\n')
    return await waitFor(() => fired, 3_000)
  } finally {
    watcher.close()
    await rm(dir, { recursive: true, force: true })
  }
}

let fsEventsDelivered = false

describe('execution-root-watcher', () => {
  let root = ''

  before(async () => {
    fsEventsDelivered = await detectFsEventDelivery()
  })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-exec-watch-'))
    clearAllToolResultCachesForTest()
  })

  afterEach(async () => {
    stopAllExecutionRootWatchers()
    clearAllToolResultCachesForTest()
    if (root) await rm(root, { recursive: true, force: true })
  })

  describe('watch lifecycle', () => {
    it('watches a root once, idempotently', () => {
      assert.equal(ensureExecutionRootWatched(root), true)
      assert.equal(ensureExecutionRootWatched(root), true)
      assert.deepEqual(watchedExecutionRootsForTest(), [root])
    })

    it('reports failure for a root that cannot be watched', () => {
      assert.equal(ensureExecutionRootWatched(join(root, 'does-not-exist')), false)
      assert.deepEqual(watchedExecutionRootsForTest(), [])
    })

    it('drops the watcher once the root is unwatched', () => {
      ensureExecutionRootWatched(root)
      stopWatchingExecutionRoot(root)
      assert.deepEqual(watchedExecutionRootsForTest(), [])
    })

    // Without a bound, every root a thread ever cached against keeps a
    // recursive watch alive for the life of the process.
    it('reclaims watchers for roots nothing caches anymore', async () => {
      const roots: string[] = []
      for (let i = 0; i < 9; i++) {
        const dir = await mkdtemp(join(tmpdir(), `copse-bound-${String(i)}-`))
        roots.push(dir)
        assert.equal(ensureExecutionRootWatched(dir), true)
      }
      try {
        assert.ok(
          watchedExecutionRootsForTest().length <= 8,
          `expected at most 8 watched roots, got ${String(watchedExecutionRootsForTest().length)}`,
        )
      } finally {
        stopAllExecutionRootWatchers()
        await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })))
      }
    })

    it('keeps watching a root that still has cached results', async () => {
      const other = await mkdtemp(join(tmpdir(), 'copse-keep-'))
      try {
        ensureExecutionRootWatched(root)
        setCachedToolResult(identity(root), 'find_files', {}, 'kept')
        for (let i = 0; i < 9; i++) ensureExecutionRootWatched(other)
        assert.ok(
          watchedExecutionRootsForTest().includes(root),
          'a root with live cached results must survive pruning',
        )
      } finally {
        await rm(other, { recursive: true, force: true })
      }
    })
  })

  // The mapping from an fs.watch event to an invalidation, driven directly so
  // it does not depend on the OS delivering anything.
  describe('event handling', () => {
    it('invalidates an entry whose scope contains the changed file', () => {
      setCachedToolResult(identity(root), 'search_code', { path: 'src' }, 'src-hits')
      handleExecutionRootEvent(root, join('src', 'main.ts'))
      assert.equal(getCachedToolResult(identity(root), 'search_code', { path: 'src' }), undefined)
    })

    it('spares an entry scoped to a directory the change did not touch', () => {
      setCachedToolResult(identity(root), 'search_code', { path: 'docs' }, 'docs-hits')
      handleExecutionRootEvent(root, join('src', 'main.ts'))
      assert.equal(
        getCachedToolResult(identity(root), 'search_code', { path: 'docs' }),
        'docs-hits',
      )
    })

    it('invalidates everything under the root when the filename is unknown', () => {
      setCachedToolResult(identity(root), 'search_code', { path: 'docs' }, 'docs-hits')
      handleExecutionRootEvent(root, null)
      assert.equal(getCachedToolResult(identity(root), 'search_code', { path: 'docs' }), undefined)
    })

    // A terminal-side `git checkout` moves .git/HEAD, which the dotfile ignore
    // rule would otherwise swallow.
    it('treats a moved branch pointer as invalidating the whole root', () => {
      setCachedToolResult(identity(root), 'search_code', { path: 'docs' }, 'docs-hits')
      handleExecutionRootEvent(root, join('.git', 'HEAD'))
      assert.equal(getCachedToolResult(identity(root), 'search_code', { path: 'docs' }), undefined)
    })

    it('ignores other .git churn', () => {
      setCachedToolResult(identity(root), 'search_code', { path: 'docs' }, 'docs-hits')
      handleExecutionRootEvent(root, join('.git', 'COMMIT_EDITMSG'))
      assert.equal(
        getCachedToolResult(identity(root), 'search_code', { path: 'docs' }),
        'docs-hits',
      )
    })

    it('ignores churn under ignored directories', () => {
      setCachedToolResult(identity(root), 'search_code', { pattern: 'foo' }, 'kept')
      handleExecutionRootEvent(root, join('node_modules', 'pkg', 'index.js'))
      assert.equal(getCachedToolResult(identity(root), 'search_code', { pattern: 'foo' }), 'kept')
    })
  })

  // One end-to-end check that the callback is actually wired to fs.watch.
  // Everything it would assert is covered deterministically above, so this
  // skips rather than fails where the platform does not deliver events.
  describe('real filesystem integration', () => {
    it('clears a cached result when a real write lands under the root', async (t) => {
      if (!fsEventsDelivered) {
        t.skip('recursive fs.watch does not deliver events in this environment')
        return
      }
      ensureExecutionRootWatched(root)
      setCachedToolResult(identity(root), 'search_code', { pattern: 'foo' }, 'stale')
      await writeFile(join(root, 'touched.ts'), 'export const a = 1\n')
      const cleared = await waitFor(
        () => getCachedToolResult(identity(root), 'search_code', { pattern: 'foo' }) === undefined,
      )
      assert.ok(cleared, 'expected the external write to drop the cached result')
    })
  })
})
