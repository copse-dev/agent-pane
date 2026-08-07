import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { setSetting } from '../storage/settings.ts'
import { storageSet } from '../storage/storage.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import {
  buildSemanticSearchPromptBlock,
  executeSemanticSearch,
  semanticIndexBuildingNote,
  setWorktreeSemanticOverlayExecutorForTest,
} from './semantic-search.ts'
import {
  setSemanticBackendForTest,
  setSemanticIndexReadyForTest,
  setSemanticSearchExecutorForTest,
  isSemanticSearchAvailable,
} from './semantic-index.ts'
import { resetWorkspaceIndexStatusForTest, setSemanticIndexScaleGuarded } from './index-status.ts'

describe('semantic-search', () => {
  afterEach(() => {
    setSemanticBackendForTest(null)
    setSemanticSearchExecutorForTest(null)
    setSemanticIndexReadyForTest(null)
    setWorktreeSemanticOverlayExecutorForTest(null)
    resetWorkspaceIndexStatusForTest()
  })

  it('builds native routing guidance when semantic backend is available', () => {
    setSemanticBackendForTest('gortex')
    assert.match(
      buildSemanticSearchPromptBlock(),
      /search_codebase \(auto\/semantic\) or semantic_search/,
    )
  })

  it('returns unavailable when semantic backend is disabled on SSH workspaces', async () => {
    await setSetting('sshWorkspaceEnabled', true)
    await setSetting('sshWorkspaceHosts', [{ id: 'dev', label: 'Dev', host: 'h.example' }])
    storageSet('activeProjectId', 'p1')
    storageSet('projects', [{ id: 'p1', path: '/remote/repo', sshHost: 'dev' }])
    setWorkspaceRootForTest('/remote/repo')
    setSemanticBackendForTest('gortex')
    assert.equal(isSemanticSearchAvailable(), false)
    assert.match(semanticIndexBuildingNote(), /SSH remote workspaces/)
    await setSetting('sshWorkspaceEnabled', false)
    storageSet('activeProjectId', null)
    storageSet('projects', [])
    setWorkspaceRootForTest(null)
  })

  it('executes native semantic search once the index is ready', async () => {
    const restoreWorkspace = setWorkspaceRootForTest('/tmp/repo')
    setSemanticBackendForTest('gortex')
    setSemanticIndexReadyForTest('/tmp/repo')
    setSemanticSearchExecutorForTest(async () => ({
      hits: [{ path: 'src/a.ts', startLine: 1, text: 'native hit' }],
      backend: 'gortex',
    }))

    try {
      const result = await executeSemanticSearch(
        { query: 'where is auth handled' },
        new AbortController().signal,
      )
      assert.ok(result.status === 'ok', `expected ok, got ${result.status}`)
      assert.match(result.text, /native hit/)
    } finally {
      restoreWorkspace()
    }
  })

  it('queries the shared index and overlays worktree-local changes', async () => {
    const restoreWorkspace = setWorkspaceRootForTest('/tmp/project')
    setSemanticBackendForTest('gortex')
    setSemanticIndexReadyForTest('/tmp/project')
    let searchedRoot = ''
    setSemanticSearchExecutorForTest(async (options) => {
      searchedRoot = options.workspaceRoot
      return {
        hits: [
          { path: 'src/changed.ts', startLine: 4, text: 'stale shared hit' },
          { path: 'src/stable.ts', startLine: 8, text: 'stable shared hit' },
        ],
        backend: 'gortex',
      }
    })
    setWorktreeSemanticOverlayExecutorForTest(async (options) => {
      assert.equal(options.projectRoot, '/tmp/project')
      assert.equal(options.worktreeRoot, '/tmp/worktree')
      assert.equal(options.baselineHits.length, 2)
      const stableHit = options.baselineHits[1]
      assert.ok(stableHit)
      return {
        hits: [
          { path: 'src/changed.ts', startLine: 12, text: '[worktree delta] current hit' },
          stableHit,
        ],
        changedPathCount: 1,
      }
    })

    try {
      const result = await runWithThreadExecutionContext(
        {
          projectId: 'p1',
          threadId: 't1',
          projectRoot: '/tmp/project',
          root: '/tmp/worktree',
          checkoutMode: 'worktree',
          branch: 'copse/t1',
        },
        () =>
          executeSemanticSearch({ query: 'current implementation' }, new AbortController().signal),
      )
      assert.equal(searchedRoot, '/tmp/project')
      assert.ok(result.status === 'ok', `expected ok, got ${result.status}`)
      assert.match(result.text, /worktree delta.*current hit/)
      assert.match(result.text, /stable shared hit/)
      assert.doesNotMatch(result.text, /stale shared hit/)
      assert.match(result.text, /overlay across 1 changed paths/)
    } finally {
      restoreWorkspace()
    }
  })

  it('can query the shared snapshot without applying the worktree delta', async () => {
    const restoreWorkspace = setWorkspaceRootForTest('/tmp/project')
    setSemanticBackendForTest('gortex')
    setSemanticIndexReadyForTest('/tmp/project')
    setSemanticSearchExecutorForTest(async () => ({
      hits: [{ path: 'src/shared.ts', startLine: 1, text: 'shared snapshot' }],
      backend: 'gortex',
    }))
    setWorktreeSemanticOverlayExecutorForTest(async () => {
      throw new Error('overlay must not run')
    })

    try {
      const result = await runWithThreadExecutionContext(
        {
          projectId: 'p1',
          threadId: 't1',
          projectRoot: '/tmp/project',
          root: '/tmp/worktree',
          checkoutMode: 'worktree',
          branch: 'copse/t1',
        },
        () =>
          executeSemanticSearch(
            { query: 'shared implementation', includeWorktreeDelta: false },
            new AbortController().signal,
          ),
      )
      assert.ok(result.status === 'ok', `expected ok, got ${result.status}`)
      assert.match(result.text, /shared snapshot/)
      assert.doesNotMatch(result.text, /worktree delta overlay/)
    } finally {
      restoreWorkspace()
    }
  })

  it('reports building instead of blocking while the index is cold', async () => {
    const restoreWorkspace = setWorkspaceRootForTest('/tmp/repo')
    setSemanticBackendForTest('gortex')
    // Executor would be reached only if the readiness gate were skipped.
    setSemanticSearchExecutorForTest(async () => {
      throw new Error('search must not run against a cold index')
    })

    try {
      const result = await executeSemanticSearch(
        { query: 'where is auth handled' },
        new AbortController().signal,
      )
      assert.deepEqual(result, { status: 'building' })
    } finally {
      restoreWorkspace()
    }
  })

  it('reports unavailable when no semantic backend exists', async () => {
    const restoreWorkspace = setWorkspaceRootForTest('/tmp/repo')
    setSemanticBackendForTest(null)
    try {
      const result = await executeSemanticSearch(
        { query: 'where is auth handled' },
        new AbortController().signal,
      )
      assert.deepEqual(result, { status: 'unavailable' })
    } finally {
      restoreWorkspace()
    }
  })

  it('returns unavailable with a scale-guard note when semantic indexing is skipped', async () => {
    const restoreWorkspace = setWorkspaceRootForTest('/tmp/repo')
    setSemanticBackendForTest('gortex')
    setSemanticIndexScaleGuarded('skipped', 'Workspace has 120,000 indexed paths')
    setSemanticSearchExecutorForTest(async () => {
      throw new Error('search must not run when scale-guarded')
    })
    try {
      const result = await executeSemanticSearch(
        { query: 'where is auth handled' },
        new AbortController().signal,
      )
      assert.deepEqual(result, { status: 'unavailable' })
      assert.match(semanticIndexBuildingNote(), /skipped/)
      assert.match(semanticIndexBuildingNote(), /120,000 indexed paths/)
    } finally {
      restoreWorkspace()
    }
  })

  it('building note steers the model to regex tools', () => {
    assert.match(semanticIndexBuildingNote(), /still building/)
    assert.match(semanticIndexBuildingNote(), /search_code/)
  })
})
