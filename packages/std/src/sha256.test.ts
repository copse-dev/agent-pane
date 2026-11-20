import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sha256Hex } from './sha256.ts'

const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

describe('sha256Hex', () => {
  it('matches the published SHA-256 test vectors', () => {
    assert.equal(sha256Hex(''), EMPTY)
    assert.equal(sha256Hex('abc'), ABC)
  })

  it('hashes a string as UTF-8, the same bytes as a Buffer or Uint8Array', () => {
    const text = 'naïve café ✓'
    assert.equal(sha256Hex(text), sha256Hex(Buffer.from(text, 'utf8')))
    assert.equal(sha256Hex(text), sha256Hex(new TextEncoder().encode(text)))
    assert.match(sha256Hex(text), /^[0-9a-f]{64}$/)
  })
})
