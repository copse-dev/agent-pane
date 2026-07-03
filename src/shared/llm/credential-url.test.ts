import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isLoopbackHostname,
  isPrivateOrLinkLocalHost,
  isSafeCredentialBaseUrl,
  validateCredentialBaseUrl,
} from './credential-url.ts'

describe('validateCredentialBaseUrl', () => {
  it('accepts https to a public host', () => {
    assert.equal(
      validateCredentialBaseUrl('https://api.together.xyz/v1'),
      'https://api.together.xyz/v1',
    )
  })

  it('accepts http only for loopback hosts', () => {
    assert.equal(validateCredentialBaseUrl('http://localhost:1234/v1'), 'http://localhost:1234/v1')
    assert.equal(validateCredentialBaseUrl('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1')
    assert.throws(
      () => validateCredentialBaseUrl('http://attacker.example/v1'),
      /may only use http/,
    )
    assert.throws(
      () => validateCredentialBaseUrl('http://169.254.169.254/latest'),
      /may only use http/,
    )
  })

  it('rejects https to a private or link-local address, but allows loopback', () => {
    assert.throws(
      () => validateCredentialBaseUrl('https://169.254.169.254/latest'),
      /private or link-local/,
    )
    assert.throws(() => validateCredentialBaseUrl('https://10.0.0.5/v1'), /private or link-local/)
    assert.throws(
      () => validateCredentialBaseUrl('https://192.168.1.5/v1'),
      /private or link-local/,
    )
    assert.throws(() => validateCredentialBaseUrl('https://[fd00::1]/v1'), /private or link-local/)
    assert.equal(validateCredentialBaseUrl('https://localhost/v1'), 'https://localhost/v1')
    assert.equal(validateCredentialBaseUrl('https://[::1]/v1'), 'https://[::1]/v1')
  })

  it('rejects embedded credentials, blanks, and non-http(s) schemes', () => {
    assert.throws(
      () => validateCredentialBaseUrl('https://user:pass@evil.example'),
      /embedded credentials/,
    )
    assert.throws(() => validateCredentialBaseUrl('   '), /cannot be blank/)
    assert.throws(() => validateCredentialBaseUrl('ftp://host/x'), /must use https/)
    assert.throws(() => validateCredentialBaseUrl('not a url'), /not a valid URL/)
  })

  it('labels error messages with the caller-supplied field name', () => {
    assert.throws(
      () => validateCredentialBaseUrl('', 'Remote agent base URL'),
      /Remote agent base URL cannot be blank/,
    )
  })

  it('exposes a boolean form for fail-closed read paths', () => {
    assert.equal(isSafeCredentialBaseUrl('https://api.x.ai/v1'), true)
    assert.equal(isSafeCredentialBaseUrl('http://evil.example/v1'), false)
    assert.equal(isSafeCredentialBaseUrl('https://169.254.169.254/latest'), false)
  })

  it('treats only localhost/127.0.0.1/::1 as loopback', () => {
    assert.equal(isLoopbackHostname('localhost'), true)
    assert.equal(isLoopbackHostname('127.0.0.1'), true)
    assert.equal(isLoopbackHostname('::1'), true)
    assert.equal(isLoopbackHostname('169.254.169.254'), false)
  })
})

describe('isPrivateOrLinkLocalHost', () => {
  it('flags private, loopback, link-local, and special IPv4 ranges', () => {
    for (const host of [
      '0.0.0.0',
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
    ]) {
      assert.equal(isPrivateOrLinkLocalHost(host), true, host)
    }
  })

  it('flags ULA and link-local IPv6, including bracketed forms', () => {
    for (const host of ['::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', '[fd00::1]']) {
      assert.equal(isPrivateOrLinkLocalHost(host), true, host)
    }
  })

  it('passes public IPs and hostnames through', () => {
    for (const host of [
      '8.8.8.8',
      '1.1.1.1',
      '2606:4700::1111',
      'api.together.xyz',
      'example.com',
    ]) {
      assert.equal(isPrivateOrLinkLocalHost(host), false, host)
    }
  })

  it('does not misclassify hostnames that merely start with fc/fd', () => {
    assert.equal(isPrivateOrLinkLocalHost('fd-cdn.example.com'), false)
    assert.equal(isPrivateOrLinkLocalHost('172.200.0.1'), false)
  })
})
