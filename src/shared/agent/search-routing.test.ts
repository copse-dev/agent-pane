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

  it('prefers native semantic search guidance when available', () => {
    const block = buildSearchRoutingPromptBlock(true)
    assert.match(block, /search_codebase \(auto\/semantic\) or semantic_search/)
  })

  it('falls back to keyword search guidance without native semantic search', () => {
    const block = buildSearchRoutingPromptBlock(false)
    assert.match(block, /search_code with descriptive keywords/)
  })
})
