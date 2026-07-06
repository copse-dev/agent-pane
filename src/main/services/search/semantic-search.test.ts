import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setWorkspaceRootForTest } from '../workspace.ts'
import {
  buildSemanticSearchPromptBlock,
  executeSemanticSearch,
  semanticIndexBuildingNote,
} from './semantic-search.ts'
import {
  setSemanticBackendForTest,
  setSemanticIndexReadyForTest,
  setSemanticSearchExecutorForTest,
} from './semantic-index.ts'

describe('semantic-search', () => {
  afterEach(() => {
    setSemanticBackendForTest(null)
    setSemanticSearchExecutorForTest(null)
    setSemanticIndexReadyForTest(null)
  })

  it('builds native routing guidance when semantic backend is available', () => {
    setSemanticBackendForTest('gortex')
    assert.match(
      buildSemanticSearchPromptBlock(),
      /search_codebase \(auto\/semantic\) or semantic_search/,
    )
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

  it('building note steers the model to regex tools', () => {
    assert.match(semanticIndexBuildingNote(), /still building/)
    assert.match(semanticIndexBuildingNote(), /search_code/)
  })
})
