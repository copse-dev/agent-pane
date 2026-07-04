import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { buildSemanticSearchPromptBlock, executeSemanticSearch } from './semantic-search.ts'
import { setSemanticBackendForTest, setSemanticSearchExecutorForTest } from './semantic-index.ts'

describe('semantic-search', () => {
  it('builds native routing guidance when semantic backend is available', () => {
    setSemanticBackendForTest('gortex')
    try {
      assert.match(
        buildSemanticSearchPromptBlock(),
        /search_codebase \(auto\/semantic\) or semantic_search/,
      )
    } finally {
      setSemanticBackendForTest(null)
    }
  })

  it('executes native semantic search when backend is available', async () => {
    const restoreWorkspace = setWorkspaceRootForTest('/tmp/repo')
    setSemanticBackendForTest('gortex')
    setSemanticSearchExecutorForTest(async () => ({
      hits: [{ path: 'src/a.ts', startLine: 1, text: 'native hit' }],
      backend: 'gortex',
    }))

    try {
      const result = await executeSemanticSearch(
        { query: 'where is auth handled' },
        new AbortController().signal,
      )
      assert.match(result?.text ?? '', /native hit/)
    } finally {
      setSemanticBackendForTest(null)
      setSemanticSearchExecutorForTest(null)
      restoreWorkspace()
    }
  })

  it('returns null when native semantic search is unavailable', async () => {
    const restoreWorkspace = setWorkspaceRootForTest('/tmp/repo')
    setSemanticBackendForTest(null)
    try {
      const result = await executeSemanticSearch(
        { query: 'where is auth handled' },
        new AbortController().signal,
      )
      assert.equal(result, null)
    } finally {
      restoreWorkspace()
    }
  })
})
