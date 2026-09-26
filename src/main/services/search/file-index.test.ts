import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildIndex,
  getIndex,
  getIndexMemoryBytes,
  getIndexStats,
  invalidateIndex,
  setIndexForTest,
  whenFileIndexReady,
} from './file-index.ts'
import { getWorkspaceIndexStatus, resetWorkspaceIndexStatusForTest } from './index-status.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { setProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import { readOnlyWorkspaceSandboxOverlay } from '../../project-sandbox/config.ts'
import { setRgAvailableForTest } from '../tool-availability.ts'

describe('file-index', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-file-index-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    invalidateIndex()
    await mkdir(join(tempRoot, 'src'), { recursive: true })
    await writeFile(join(tempRoot, 'src', 'main.ts'), 'export {}\n', 'utf-8')
    await writeFile(join(tempRoot, 'package.json'), '{}\n', 'utf-8')
  })

  afterEach(async () => {
    restoreWorkspace?.()
    invalidateIndex()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('reports a complete listing as untruncated scale evidence', async () => {
    await buildIndex(tempRoot)
    const stats = getIndexStats(tempRoot)
    assert.ok(stats)
    assert.equal(stats.listingTruncated, false)
    assert.ok(stats.pathCount > 0)
  })

  it('has no stats for a root that was never listed', () => {
    assert.equal(getIndexStats(join(tempRoot, 'nope')), null)
  })

  it('builds a path index for the workspace', async () => {
    await buildIndex(tempRoot)
    const idx = getIndex(tempRoot)
    assert.ok(idx)
    assert.ok(idx.paths.includes('src/main.ts'))
    assert.ok(idx.paths.includes('package.json'))
    assert.ok(idx.lastBuilt > 0)
    assert.ok((getIndexMemoryBytes(tempRoot) ?? 0) > 0)
  })

  it('reports building while a build is in flight, then ready', async () => {
    resetWorkspaceIndexStatusForTest()
    const build = buildIndex(tempRoot)
    assert.equal(getWorkspaceIndexStatus().fileIndex.phase, 'building')
    await build
    assert.equal(getWorkspaceIndexStatus().fileIndex.phase, 'ready')
  })

  it('whenFileIndexReady rides an in-flight build and resolves immediately when idle', async () => {
    const build = buildIndex(tempRoot)
    await whenFileIndexReady(tempRoot)
    assert.ok(getIndex(tempRoot))
    await build
    // No build in flight — must resolve without hanging.
    await whenFileIndexReady(tempRoot)
  })

  it('serves a stale index immediately while a rebuild is in flight (no starvation)', async () => {
    // The recursive workspace watcher re-arms a rebuild on every file write, so
    // a busy workspace keeps builds perpetually in flight. Consumers must be
    // served the existing snapshot rather than waiting for quiescence — the old
    // `while (buildInFlight)` loop starved the `@` mention picker indefinitely.
    setIndexForTest(['stale-marker.ts'], tempRoot)
    const build = buildIndex(tempRoot)
    await whenFileIndexReady(tempRoot)
    // Resolved from the stale snapshot, before the rebuild swapped it out.
    assert.ok(getIndex(tempRoot)?.paths.includes('stale-marker.ts'))
    await build
    assert.ok(getIndex(tempRoot)?.paths.includes('src/main.ts'))
  })

  it('skips ignored build-output dirs in the no-rg walk fallback', async () => {
    // Without rg (e.g. CI containers) buildIndex walks the tree; walking dist/
    // and vendor/ made each rebuild take tens of seconds there.
    await mkdir(join(tempRoot, 'dist', 'main'), { recursive: true })
    await writeFile(join(tempRoot, 'dist', 'main', 'index.js'), '// built\n', 'utf-8')
    await mkdir(join(tempRoot, 'vendor'), { recursive: true })
    await writeFile(join(tempRoot, 'vendor', 'big.bin'), 'x\n', 'utf-8')
    await buildIndex(tempRoot)
    const idx = getIndex(tempRoot)
    assert.ok(idx)
    assert.ok(idx.paths.includes('src/main.ts'))
    assert.equal(
      idx.paths.some((p) => p.startsWith('dist/') || p.startsWith('vendor/')),
      false,
      'build output must not be indexed by the walk fallback',
    )
  })

  it('coalesces concurrent buildIndex callers onto one listing', async () => {
    resetWorkspaceIndexStatusForTest()
    const [a, b] = await Promise.all([buildIndex(tempRoot), buildIndex(tempRoot)])
    assert.equal(a, undefined)
    assert.equal(b, undefined)
    // Two callers must not leave the active-build counter stuck above zero.
    assert.equal(getWorkspaceIndexStatus().fileIndex.phase, 'ready')
    assert.ok(getIndex(tempRoot)?.paths.includes('src/main.ts'))
  })

  it('keeps independent indexes per root — a worktree root never serves the workspace listing', async () => {
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'copse-panel-file-index-worktree-'))
    try {
      await writeFile(join(worktreeRoot, 'only-in-worktree.ts'), 'export {}\n', 'utf-8')
      await Promise.all([buildIndex(tempRoot), buildIndex(worktreeRoot)])
      assert.ok(getIndex(tempRoot)?.paths.includes('src/main.ts'))
      assert.equal(getIndex(tempRoot)?.paths.includes('only-in-worktree.ts'), false)
      assert.ok(getIndex(worktreeRoot)?.paths.includes('only-in-worktree.ts'))
      assert.equal(getIndex(worktreeRoot)?.paths.includes('src/main.ts'), false)
    } finally {
      invalidateIndex(worktreeRoot)
      await rm(worktreeRoot, { recursive: true, force: true })
    }
  })

  // Workspace open lists the checkout before the user does anything. Under the
  // writable overlay, Linux bubblewrap creates empty host placeholders for every
  // missing mandatory write-deny path (.bashrc, .gitconfig, .vscode, ...), and
  // they stay visible to `git status` while any sandbox is active.
  it('lists through the read-only sandbox overlay when the project sandbox is active', async () => {
    const overlays: (Partial<SandboxRuntimeConfig> | undefined)[] = []
    let released = 0
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    mock.method(SandboxManager, 'cleanupAfterCommand', () => {
      released += 1
    })
    mock.method(
      SandboxManager,
      'wrapWithSandboxArgv',
      (_command: string, _shell?: string, customConfig?: Partial<SandboxRuntimeConfig>) => {
        overlays.push(customConfig)
        // Stand in for `rg --files` so the test does not depend on ripgrep.
        const listing = `${join(tempRoot, 'src', 'main.ts')}\n`
        return Promise.resolve({
          argv: ['/bin/sh', '-c', 'printf %s "$0"', listing],
          env: { ...process.env },
        })
      },
    )
    setRgAvailableForTest(true)
    setProjectSandboxEnabled(true)
    try {
      await buildIndex(tempRoot)
    } finally {
      setProjectSandboxEnabled(false)
      setRgAvailableForTest(null)
      mock.restoreAll()
    }

    assert.deepEqual(getIndex(tempRoot)?.paths, ['src/main.ts'])
    assert.equal(overlays.length, 1)
    const filesystem = overlays[0]?.filesystem
    assert.ok(filesystem)
    assert.deepEqual(filesystem.allowWrite, [])
    assert.deepEqual(filesystem.denyWrite, [])
    assert.deepEqual(overlays[0], readOnlyWorkspaceSandboxOverlay(tempRoot))
    assert.equal(released, 1)
  })
})
