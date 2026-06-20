import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifySearchQuery, buildSearchRoutingPromptBlock } from './search-routing.ts'

describe('search-routing', () => {
  it('routes identifier-like queries to regex search', () => {
    assert.equal(classifySearchQuery('PaymentService'), 'regex')
    assert.equal(classifySearchQuery('import.*foo'), 'regex')
    assert.equal(classifySearchQuery('src/main/index.ts'), 'regex')
  })

  it('routes natural-language questions to semantic search', () => {
    assert.equal(classifySearchQuery('where is authentication handled'), 'semantic')
    assert.equal(classifySearchQuery('how does failed payment retry work'), 'semantic')
  })

  it('includes semantic MCP tools in the routing prompt when present', () => {
    const block = buildSearchRoutingPromptBlock(['mcp__vera__search_code'])
    assert.match(block, /mcp__vera__search_code/)
    assert.match(block, /semantic MCP tools first/)
  })

  it('falls back to keyword search guidance without semantic tools', () => {
    const block = buildSearchRoutingPromptBlock([])
    assert.match(block, /search_code with descriptive keywords/)
  })
})
