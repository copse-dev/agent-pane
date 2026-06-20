import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolRegistry } from './tool-registry.ts'
import { setPermissionGateForTests } from './tool-registry.ts'
import {
  buildSemanticSearchPromptBlock,
  isSemanticMcpTool,
  listSemanticMcpTools,
} from './semantic-search.ts'
import { z } from 'zod'

describe('semantic-search', () => {
  it('detects semantic MCP tool names', () => {
    assert.equal(isSemanticMcpTool('mcp__vera__search_code'), true)
    assert.equal(isSemanticMcpTool('mcp__locus__search_codebase'), true)
    assert.equal(isSemanticMcpTool('search_code'), false)
  })

  it('builds a routing prompt block from connected semantic tools', () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'mcp__vera__search_code',
      description: 'semantic',
      parameters: z.object({ query: z.string() }),
      async execute() {
        return 'ok'
      },
    })
    setPermissionGateForTests(async () => true)
    assert.deepEqual(listSemanticMcpTools(registry), ['mcp__vera__search_code'])
    assert.match(buildSemanticSearchPromptBlock(registry), /vera/)
    setPermissionGateForTests(null)
  })
})
