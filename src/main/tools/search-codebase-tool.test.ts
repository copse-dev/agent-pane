import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizeToolExecuteResult } from '@shared/types'
import { ToolRegistry, setPermissionGateForTests } from '../services/tool-registry.ts'
import { searchCodebaseTool } from './search-codebase-tool.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import { setIndexedGrepBackendForTest } from '../services/search/indexed-grep.ts'
import { setRgAvailableForTest } from '../services/tool-availability.ts'
import {
  setSemanticBackendForTest,
  setSemanticIndexReadyForTest,
  setSemanticSearchExecutorForTest,
} from '../services/search/semantic-index.ts'

describe('search_codebase tool', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined
  let registry: ToolRegistry

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-search-codebase-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    await writeFile(join(tempRoot, 'auth.ts'), 'export function authenticate() {}\n', 'utf-8')
    registry = new ToolRegistry()
    registry.register(searchCodebaseTool)
    setPermissionGateForTests(async () => true)
    setIndexedGrepBackendForTest('rg')
    setRgAvailableForTest(true)
    setSemanticBackendForTest(null)
    setSemanticSearchExecutorForTest(null)
    setSemanticIndexReadyForTest(tempRoot)
  })

  afterEach(async () => {
    setPermissionGateForTests(null)
    setIndexedGrepBackendForTest(null)
    setRgAvailableForTest(null)
    setSemanticBackendForTest(null)
    setSemanticSearchExecutorForTest(null)
    setSemanticIndexReadyForTest(null)
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('routes identifier queries through regex search', async () => {
    const result = normalizeToolExecuteResult(
      await registry.execute(
        'search_codebase',
        { query: 'authenticate', mode: 'auto' },
        new AbortController().signal,
      ),
    ).result
    assert.match(result, /\[regex search\]/)
    assert.match(result, /auth\.ts/)
  })

  it('accepts the `pattern` alias in place of `query`', async () => {
    const result = normalizeToolExecuteResult(
      await registry.execute(
        'search_codebase',
        { pattern: 'authenticate', mode: 'auto' },
        new AbortController().signal,
      ),
    ).result
    assert.match(result, /\[regex search\]/)
    assert.match(result, /auth\.ts/)
  })

  it('reports a helpful message when neither query nor pattern is given', async () => {
    const result = normalizeToolExecuteResult(
      await registry.execute('search_codebase', { mode: 'auto' }, new AbortController().signal),
    ).result
    assert.match(result, /Provide a search query/)
    assert.match(result, /pattern/)
  })

  it('uses native semantic search when available', async () => {
    setSemanticBackendForTest('gortex')
    setSemanticSearchExecutorForTest(async ({ query }) => ({
      hits: [
        {
          path: 'src/auth.ts',
          startLine: 1,
          text: `semantic hit for ${query}`,
        },
      ],
      backend: 'gortex',
    }))

    const result = normalizeToolExecuteResult(
      await registry.execute(
        'search_codebase',
        { query: 'where is authentication handled', mode: 'auto' },
        new AbortController().signal,
      ),
    ).result
    assert.match(result, /\[native semantic search\]/)
    assert.match(result, /semantic hit/)
  })

  it('falls back to regex when native semantic search is unavailable', async () => {
    const result = normalizeToolExecuteResult(
      await registry.execute(
        'search_codebase',
        { query: 'where is authentication handled', mode: 'auto' },
        new AbortController().signal,
      ),
    ).result
    assert.match(result, /\[semantic search unavailable — regex fallback\]/)
  })

  it('reports when semantic mode is requested but unavailable', async () => {
    const result = normalizeToolExecuteResult(
      await registry.execute(
        'search_codebase',
        { query: 'where is auth handled', mode: 'semantic' },
        new AbortController().signal,
      ),
    ).result
    assert.match(result, /Semantic search unavailable/)
    assert.match(result, /gortex/)
  })

  it('falls back to regex without blocking while the semantic index is cold', async () => {
    setSemanticBackendForTest('gortex')
    setSemanticIndexReadyForTest(null) // cold: no build pass has completed
    setSemanticSearchExecutorForTest(async () => {
      throw new Error('search must not run against a cold index')
    })

    const result = normalizeToolExecuteResult(
      await registry.execute(
        'search_codebase',
        { query: 'where is authentication handled', mode: 'auto' },
        new AbortController().signal,
      ),
    ).result
    assert.match(result, /\[semantic index still building — regex fallback\]/)
  })

  it('returns the building note instead of blocking in explicit semantic mode', async () => {
    setSemanticBackendForTest('gortex')
    setSemanticIndexReadyForTest(null)

    const result = normalizeToolExecuteResult(
      await registry.execute(
        'search_codebase',
        { query: 'where is auth handled', mode: 'semantic' },
        new AbortController().signal,
      ),
    ).result
    assert.match(result, /still building/)
    assert.match(result, /search_code/)
  })
})
