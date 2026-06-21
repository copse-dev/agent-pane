import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLmStudioApiKey } from './lm-studio-api-key.ts'

describe('resolveLmStudioApiKey', () => {
  it('prefers stored key over env', () => {
    assert.equal(resolveLmStudioApiKey('stored', { LM_STUDIO_API_KEY: 'env' }), 'stored')
  })

  it('uses LM_STUDIO_API_KEY then LM_API_TOKEN', () => {
    assert.equal(resolveLmStudioApiKey(null, { LM_STUDIO_API_KEY: 'a' }), 'a')
    assert.equal(resolveLmStudioApiKey('', { LM_STUDIO_API_KEY: '', LM_API_TOKEN: 'b' }), 'b')
  })

  it('falls back to lm-studio placeholder', () => {
    assert.equal(resolveLmStudioApiKey(null, {}), 'lm-studio')
  })
})
