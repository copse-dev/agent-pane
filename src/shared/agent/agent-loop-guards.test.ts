import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isDuplicateExploreCall,
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
  it('detects a repeated explore call', () => {
    const fp = toolCallFingerprint('list_dir', { path: '.' })
    assert.equal(isDuplicateExploreCall('list_dir', { path: '.' }, [fp]), true)
  })

  it('ignores non-explore tools', () => {
    const fp = toolCallFingerprint('run_shell', { command: 'npm test' })
    assert.equal(isDuplicateExploreCall('run_shell', { command: 'npm test' }, [fp]), false)
  })
})
