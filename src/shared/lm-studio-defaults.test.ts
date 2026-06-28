import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LM_STUDIO_URL, resolveLocalServerUrl } from './lm-studio-defaults.ts'

describe('resolveLocalServerUrl', () => {
  it('prefers COPSE_EVAL_LM_STUDIO_URL over stored settings', () => {
    assert.equal(
      resolveLocalServerUrl('http://localhost:1234/v1', {
        COPSE_EVAL_LM_STUDIO_URL: 'http://tunnel.example:1234/v1',
      }),
      'http://tunnel.example:1234/v1',
    )
  })

  it('uses stored URL when eval env is unset', () => {
    assert.equal(resolveLocalServerUrl('http://127.0.0.1:8080/v1', {}), 'http://127.0.0.1:8080/v1')
  })

  it('falls back to default localhost endpoint', () => {
    assert.equal(resolveLocalServerUrl('', {}), DEFAULT_LM_STUDIO_URL)
  })
})
