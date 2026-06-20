import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolRegistry, setPermissionGateForTests } from '../services/tool-registry.ts'
import { createSearchCodebaseTool } from './search-codebase-tool.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import { setIndexedGrepBackendForTest } from '../services/indexed-grep.ts'
import { setRgAvailableForTest } from '../services/tool-availability.ts'
import { z } from 'zod'

describe('search_codebase tool', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined
  let registry: ToolRegistry

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'agent-pane-search-codebase-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    await writeFile(join(tempRoot, 'auth.ts'), 'export function authenticate() {}\n', 'utf-8')
    registry = new ToolRegistry()
    registry.register(createSearchCodebaseTool(registry))
    setPermissionGateForTests(async () => true)
    setIndexedGrepBackendForTest('rg')
    setRgAvailableForTest(true)
  })

  afterEach(async () => {
    setPermissionGateForTests(null)
    setIndexedGrepBackendForTest(null)
    setRgAvailableForTest(null)
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('routes identifier queries through regex search', async () => {
    const tool = registry
    const result = await tool.execute(
      'search_codebase',
      { query: 'authenticate', mode: 'auto' },
      new AbortController().signal,
    )
    assert.match(result, /\[regex search\]/)
    assert.match(result, /auth\.ts/)
  })

  it('uses semantic MCP search when available', async () => {
    registry.register({
      name: 'mcp__vera__search_code',
      description: 'semantic',
      parameters: z.object({ query: z.string() }),
      async execute({ query }) {
        return `semantic hit for ${query}`
      },
    })

    const result = await registry.execute(
      'search_codebase',
      { query: 'where is authentication handled', mode: 'auto' },
      new AbortController().signal,
    )
    assert.match(result, /\[semantic search\]/)
    assert.match(result, /semantic hit/)
  })

  it('reports when semantic mode is requested but unavailable', async () => {
    const result = await registry.execute(
      'search_codebase',
      { query: 'where is auth handled', mode: 'semantic' },
      new AbortController().signal,
    )
    assert.match(result, /Semantic search unavailable/)
  })
})
