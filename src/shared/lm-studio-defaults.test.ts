import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LM_STUDIO_URL,
  preferIpv4LoopbackUrl,
  resolveLocalServerUrl,
} from './lm-studio-defaults.ts'

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

  it('falls back to the default IPv4 loopback endpoint', () => {
    assert.equal(resolveLocalServerUrl('', {}), DEFAULT_LM_STUDIO_URL)
    assert.equal(DEFAULT_LM_STUDIO_URL, 'http://127.0.0.1:1234/v1')
  })
})

describe('preferIpv4LoopbackUrl', () => {
  it('rewrites bare localhost to 127.0.0.1', () => {
    assert.equal(preferIpv4LoopbackUrl('http://localhost:1234/v1'), 'http://127.0.0.1:1234/v1')
    assert.equal(preferIpv4LoopbackUrl('http://localhost/v1'), 'http://127.0.0.1/v1')
    assert.equal(preferIpv4LoopbackUrl('http://LocalHost:11434/v1'), 'http://127.0.0.1:11434/v1')
  })

  it('leaves non-bare-localhost hosts alone', () => {
    assert.equal(preferIpv4LoopbackUrl('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1')
    assert.equal(
      preferIpv4LoopbackUrl('http://foo.localhost:1234/v1'),
      'http://foo.localhost:1234/v1',
    )
    assert.equal(preferIpv4LoopbackUrl('http://example.com/v1'), 'http://example.com/v1')
  })
})
