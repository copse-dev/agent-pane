import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  clearKeyReadability,
  resolveKeyReadability,
  type KeyReadabilityProbe,
} from './api-key-readability.ts'

function probe(
  encryptionAvailable: boolean,
  value: string | null,
  counter?: { calls: number },
): KeyReadabilityProbe {
  return {
    encryptionAvailable,
    readKey: (): string | null => {
      if (counter) counter.calls += 1
      return value
    },
  }
}

describe('resolveKeyReadability', () => {
  beforeEach(() => {
    clearKeyReadability()
  })

  it('reports no verdict when nothing is stored', () => {
    assert.equal(resolveKeyReadability('openai', null, probe(true, null)), null)
    assert.equal(resolveKeyReadability('openai', { enc: '' }, probe(true, null)), null)
  })

  it('treats a plaintext key as readable without attempting a decrypt', () => {
    const calls = { calls: 0 }
    assert.equal(
      resolveKeyReadability('openai', { enc: 'abc', plain: true }, probe(true, null, calls)),
      true,
    )
    assert.equal(calls.calls, 0)
  })

  it('reads an encrypted key that decrypts', () => {
    assert.equal(resolveKeyReadability('openai', { enc: 'abc' }, probe(true, 'sk-live')), true)
  })

  // The profile-restored-on-a-new-machine case: ciphertext is present, the local
  // keychain holds no key for it.
  it('reports an encrypted key that does not decrypt as unreadable', () => {
    assert.equal(resolveKeyReadability('openai', { enc: 'abc' }, probe(true, null)), false)
  })

  // A locked Linux keyring is transient. Latching "unreadable" would hide a
  // provider that works once the keyring is unlocked.
  it('does not judge a key when no cipher is available', () => {
    const calls = { calls: 0 }
    assert.equal(resolveKeyReadability('openai', { enc: 'abc' }, probe(false, null, calls)), true)
    assert.equal(calls.calls, 0)
  })

  it('caches the verdict instead of decrypting on every call', () => {
    const calls = { calls: 0 }
    for (let i = 0; i < 5; i += 1) {
      resolveKeyReadability('openai', { enc: 'abc' }, probe(true, 'sk-live', calls))
    }
    assert.equal(calls.calls, 1)
  })

  it('recomputes when the stored ciphertext changes', () => {
    assert.equal(resolveKeyReadability('openai', { enc: 'old' }, probe(true, null)), false)
    // A re-entered key must not inherit the previous verdict.
    assert.equal(resolveKeyReadability('openai', { enc: 'new' }, probe(true, 'sk-live')), true)
  })

  it('keeps verdicts separate per provider', () => {
    assert.equal(resolveKeyReadability('openai', { enc: 'abc' }, probe(true, null)), false)
    assert.equal(resolveKeyReadability('anthropic', { enc: 'abc' }, probe(true, 'sk-live')), true)
  })

  it('drops a cached verdict when cleared', () => {
    assert.equal(resolveKeyReadability('openai', { enc: 'abc' }, probe(true, null)), false)
    clearKeyReadability('openai')
    assert.equal(resolveKeyReadability('openai', { enc: 'abc' }, probe(true, 'sk-live')), true)
  })
})
