import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DUPLICATE_GUARDED_TOOL_NAMES,
  hasOpenTodos,
  isDuplicateExploreCall,
  isNearDuplicateQuery,
  toolCallFingerprint,
  normalizeExploreArgs,
} from './agent-loop-guards.ts'

describe('toolCallFingerprint', () => {
  it('treats equivalent list_dir args as the same key', () => {
    const a = toolCallFingerprint('list_dir', normalizeExploreArgs('list_dir', { path: '.' }))
    const b = toolCallFingerprint('list_dir', normalizeExploreArgs('list_dir', {}))
    assert.equal(a, b)
  })
})

describe('isDuplicateExploreCall', () => {
  it('detects a repeated explore subagent call', () => {
    const fp = toolCallFingerprint('explore', { query: 'find the auth handler' })
    assert.equal(isDuplicateExploreCall('explore', { query: 'find the auth handler' }, [fp]), true)
  })

  it('detects a repeated semantic search call', () => {
    const fp = toolCallFingerprint('semantic_search', { query: 'find the auth handler' })
    assert.equal(
      isDuplicateExploreCall('semantic_search', { query: 'find the auth handler' }, [fp]),
      true,
    )
  })

  it('guards every parent context-gathering tool named by the loop policy', () => {
    assert.equal(DUPLICATE_GUARDED_TOOL_NAMES.has('explore'), true)
    assert.equal(DUPLICATE_GUARDED_TOOL_NAMES.has('semantic_search'), true)
  })

  it('detects a paraphrased explore query against the same paths', () => {
    const paths = ['src/renderer/views/browser-pane.ts']
    const fp = toolCallFingerprint('explore', {
      query: 'browser-pane.ts urlInput keydown enter handler implementation details',
      paths,
    })
    assert.equal(
      isDuplicateExploreCall('explore', { query: 'exact code urlInput keydown Enter key', paths }, [
        fp,
      ]),
      true,
    )
  })

  it('collapses the observed exact-text query loop onto its first call', () => {
    const paths = ['src/renderer/views/browser-pane.ts']
    const queries = [
      'browser-pane.ts wireToolbar urlInput keydown handler implementation',
      'browser-pane.ts urlInput keydown enter handler implementation details',
      'browser-pane.ts exact code urlInput keydown handler Enter key',
      'browser-pane.ts exact lines urlInput addEventListener keydown Enter submitUrl',
      'browser-pane.ts urlInput keydown exact whitespace',
      'browser-pane.ts urlInput keydown lines 308-316 exact whitespace',
      'browser-pane.ts urlInput keydown exact lines whitespace including spaces and indentation',
    ]
    const recent = [toolCallFingerprint('explore', { query: queries[0], paths })]
    for (const query of queries.slice(1)) {
      assert.equal(isDuplicateExploreCall('explore', { query, paths }, recent), true, query)
      recent.push(toolCallFingerprint('explore', { query, paths }))
    }
  })

  it('keeps different questions against the same path distinct', () => {
    const paths = ['src/auth.ts']
    const fp = toolCallFingerprint('explore', { query: 'find the login validator', paths })
    assert.equal(
      isDuplicateExploreCall('explore', { query: 'find the logout redirect', paths }, [fp]),
      false,
    )
  })

  it('keeps the same question against different paths distinct', () => {
    const fp = toolCallFingerprint('explore', {
      query: 'find the auth handler',
      paths: ['src/server'],
    })
    assert.equal(
      isDuplicateExploreCall(
        'explore',
        { query: 'find the auth handler', paths: ['src/renderer'] },
        [fp],
      ),
      false,
    )
  })

  it('ignores non-explore tools', () => {
    const fp = toolCallFingerprint('run_shell', { command: 'npm test' })
    assert.equal(isDuplicateExploreCall('run_shell', { command: 'npm test' }, [fp]), false)
  })
})

describe('isNearDuplicateQuery', () => {
  it('matches high-overlap query tokens but rejects distinct intent', () => {
    assert.equal(isNearDuplicateQuery('url input keydown', 'url input keydown enter'), true)
    assert.equal(isNearDuplicateQuery('auth login validator', 'auth logout redirect'), false)
    assert.equal(isNearDuplicateQuery('toolbar click handler', 'toolbar keyboard handler'), false)
  })
})

describe('hasOpenTodos', () => {
  it('detects pending and in_progress', () => {
    assert.equal(hasOpenTodos([{ id: '1', content: 'x', status: 'completed' }]), false)
    assert.equal(hasOpenTodos([{ id: '1', content: 'x', status: 'pending' }]), true)
    assert.equal(hasOpenTodos([{ id: '1', content: 'x', status: 'in_progress' }]), true)
  })
})
