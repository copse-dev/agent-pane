import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isLoopbackHostname,
  isSafeCredentialBaseUrl,
  validateCredentialBaseUrl,
} from './credential-url.ts'

describe('validateCredentialBaseUrl', () => {
  it('accepts https to any host', () => {
    assert.equal(validateCredentialBaseUrl('https://api.together.xyz/v1'), 'https://api.together.xyz/v1')
  })

  it('accepts http only for loopback hosts', () => {
    assert.equal(validateCredentialBaseUrl('http://localhost:1234/v1'), 'http://localhost:1234/v1')
    assert.equal(validateCredentialBaseUrl('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1')
    assert.throws(() => validateCredentialBaseUrl('http://attacker.example/v1'), /may only use http/)
    assert.throws(() => validateCredentialBaseUrl('http://169.254.169.254/latest'), /may only use http/)
  })

  it('rejects embedded credentials, blanks, and non-http(s) schemes', () => {
    assert.throws(() => validateCredentialBaseUrl('https://user:pass@evil.example'), /embedded credentials/)
    assert.throws(() => validateCredentialBaseUrl('   '), /cannot be blank/)
    assert.throws(() => validateCredentialBaseUrl('ftp://host/x'), /must use https/)
    assert.throws(() => validateCredentialBaseUrl('not a url'), /not a valid URL/)
  })

  it('labels error messages with the caller-supplied field name', () => {
    assert.throws(() => validateCredentialBaseUrl('', 'Remote agent base URL'), /Remote agent base URL cannot be blank/)
  })

  it('exposes a boolean form for fail-closed read paths', () => {
    assert.equal(isSafeCredentialBaseUrl('https://api.x.ai/v1'), true)
    assert.equal(isSafeCredentialBaseUrl('http://evil.example/v1'), false)
  })

  it('treats only localhost/127.0.0.1/::1 as loopback', () => {
    assert.equal(isLoopbackHostname('localhost'), true)
    assert.equal(isLoopbackHostname('127.0.0.1'), true)
    assert.equal(isLoopbackHostname('::1'), true)
    assert.equal(isLoopbackHostname('169.254.169.254'), false)
  })
})
