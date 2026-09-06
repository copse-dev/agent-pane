import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  KEYRING_CIPHER_MAGIC,
  createKeyringCipher,
  createMigratingCipher,
  isKeyringCipherBlob,
  type DataKeyStore,
} from './keyring-cipher.ts'
import type { SecretCipher } from './secret-cipher.ts'

function memoryStore(initial: string | null = null): DataKeyStore & {
  value: string | null
  reads: number
  writes: number
} {
  const store = {
    value: initial,
    reads: 0,
    writes: 0,
    read(): string | null {
      store.reads += 1
      return store.value
    },
    write(value: string): void {
      store.writes += 1
      store.value = value
    },
  }
  return store
}

function brokenStore(): DataKeyStore {
  return {
    read(): string | null {
      throw new Error('keyring locked')
    },
    write(): void {
      throw new Error('keyring locked')
    },
  }
}

/** A stand-in for `safeStorage`: reversible, prefixed, not our format. */
function legacyCipher(available = true): SecretCipher & { encrypts: number } {
  const cipher = {
    encrypts: 0,
    isEncryptionAvailable: (): boolean => available,
    encryptString(plainText: string): Buffer {
      cipher.encrypts += 1
      return Buffer.concat([Buffer.from('v10'), Buffer.from(plainText, 'utf8').reverse()])
    },
    decryptString(encrypted: Buffer): string {
      if (encrypted.subarray(0, 3).toString() !== 'v10') throw new Error('not legacy')
      return Buffer.from(encrypted.subarray(3)).reverse().toString('utf8')
    },
  }
  return cipher
}

function shouldReencrypt(cipher: SecretCipher, blob: Buffer): boolean | undefined {
  return cipher.shouldReencrypt?.(blob)
}

describe('createKeyringCipher', () => {
  it('round-trips text and writes self-describing blobs', () => {
    const store = memoryStore()
    const cipher = createKeyringCipher(store)
    const blob = cipher.encryptString('sk-ant-secret ✓')
    assert.ok(isKeyringCipherBlob(blob))
    assert.ok(blob.subarray(0, 4).equals(KEYRING_CIPHER_MAGIC))
    assert.equal(cipher.decryptString(blob), 'sk-ant-secret ✓')
    assert.equal(shouldReencrypt(cipher, blob), false)
  })

  it('creates the data key once, on first encrypt, and reuses it', () => {
    const store = memoryStore()
    const cipher = createKeyringCipher(store)
    assert.equal(store.value, null)
    const first = cipher.encryptString('a')
    assert.equal(store.writes, 1)
    const key = store.read()
    assert.ok(key !== null && Buffer.from(key, 'base64').length === 32)
    cipher.encryptString('b')
    assert.equal(store.writes, 1)
    assert.equal(store.value, key)
    // A second instance over the same store (another launch) opens the blob.
    assert.equal(createKeyringCipher(memoryStore(key)).decryptString(first), 'a')
  })

  it('uses a fresh IV per encryption', () => {
    const cipher = createKeyringCipher(memoryStore())
    const a = cipher.encryptString('same')
    const b = cipher.encryptString('same')
    assert.notDeepEqual(a, b)
    assert.equal(cipher.decryptString(a), cipher.decryptString(b))
  })

  it('rejects tampered ciphertext, a wrong key, and foreign blobs', () => {
    const store = memoryStore()
    const cipher = createKeyringCipher(store)
    const blob = cipher.encryptString('payload')
    const tampered = Buffer.from(blob)
    tampered.writeUInt8(
      (tampered.readUInt8(tampered.length - 1) ^ 0x01) & 0xff,
      tampered.length - 1,
    )
    assert.throws(() => cipher.decryptString(tampered))

    const other = createKeyringCipher(memoryStore())
    other.encryptString('x') // materialises a different key
    assert.throws(() => other.decryptString(blob))

    assert.throws(() => cipher.decryptString(Buffer.from('v10whatever')))
    assert.equal(isKeyringCipherBlob(Buffer.from('CPS')), false)
  })

  it('does not create a key just to read', () => {
    const store = memoryStore()
    const cipher = createKeyringCipher(store)
    assert.throws(() =>
      cipher.decryptString(Buffer.concat([KEYRING_CIPHER_MAGIC, Buffer.alloc(40)])),
    )
    assert.equal(store.writes, 0)
  })

  it('reports unavailable while the keyring cannot be reached, then retries', () => {
    let clock = 0
    const calls = { n: 0 }
    let broken = true
    const store: DataKeyStore = {
      read(): string | null {
        calls.n += 1
        if (broken) throw new Error('locked')
        return null
      },
      write(): void {},
    }
    const cipher = createKeyringCipher(store, { unavailableRetryMs: 1000, now: () => clock })
    assert.equal(cipher.isEncryptionAvailable(), false)
    assert.equal(cipher.isEncryptionAvailable(), false)
    assert.equal(calls.n, 1, 'negative verdict is cached inside the retry window')
    clock = 1000
    broken = false
    assert.equal(cipher.isEncryptionAvailable(), true)
    assert.equal(calls.n, 2)
  })

  it('is available with an empty keyring (the key is created on first write)', () => {
    assert.equal(createKeyringCipher(memoryStore()).isEncryptionAvailable(), true)
    assert.equal(createKeyringCipher(brokenStore()).isEncryptionAvailable(), false)
  })

  it('refuses a stored key of the wrong size', () => {
    const cipher = createKeyringCipher(memoryStore(Buffer.alloc(16).toString('base64')))
    assert.throws(() => cipher.encryptString('x'), /wrong length/)
  })
})

describe('createMigratingCipher', () => {
  it('writes in the keyring format and reads both formats', () => {
    const legacy = legacyCipher()
    const cipher = createMigratingCipher(createKeyringCipher(memoryStore()), legacy)
    const fresh = cipher.encryptString('new')
    assert.ok(isKeyringCipherBlob(fresh))
    assert.equal(cipher.decryptString(fresh), 'new')
    assert.equal(legacy.encrypts, 0)

    const old = legacy.encryptString('old')
    assert.equal(cipher.decryptString(old), 'old')
  })

  it('asks for re-encryption of legacy blobs only while the keyring is usable', () => {
    const legacy = legacyCipher()
    const old = legacy.encryptString('old')
    const usable = createMigratingCipher(createKeyringCipher(memoryStore()), legacy)
    assert.equal(shouldReencrypt(usable, old), true)
    assert.equal(shouldReencrypt(usable, usable.encryptString('x')), false)

    const locked = createMigratingCipher(createKeyringCipher(brokenStore()), legacy)
    assert.equal(shouldReencrypt(locked, old), false)
  })

  it('falls back to the legacy cipher for writes when the keyring is unreachable', () => {
    const legacy = legacyCipher()
    const cipher = createMigratingCipher(createKeyringCipher(brokenStore()), legacy)
    assert.equal(cipher.isEncryptionAvailable(), true)
    const blob = cipher.encryptString('fallback')
    assert.equal(legacy.encrypts, 1)
    assert.equal(cipher.decryptString(blob), 'fallback')
  })

  it('falls back when a readable keyring refuses to create the data key', () => {
    const store: DataKeyStore = {
      read: () => null,
      write: () => {
        throw new Error('user interaction is not allowed')
      },
    }
    const legacy = legacyCipher()
    const cipher = createMigratingCipher(createKeyringCipher(store), legacy)

    assert.equal(cipher.isEncryptionAvailable(), true, 'the read probe itself succeeds')
    const blob = cipher.encryptString('fallback after write refusal')
    assert.equal(legacy.encrypts, 1)
    assert.equal(cipher.decryptString(blob), 'fallback after write refusal')
    assert.throws(
      () => cipher.encryptStringForMigration?.('must use the preferred format'),
      /user interaction is not allowed/,
    )
  })

  it('is unavailable and refuses to write when neither cipher can', () => {
    const cipher = createMigratingCipher(createKeyringCipher(brokenStore()), legacyCipher(false))
    assert.equal(cipher.isEncryptionAvailable(), false)
    assert.throws(() => cipher.encryptString('x'), /no secret cipher/)
  })

  it('cannot open legacy blobs without a legacy cipher (non-Electron shells)', () => {
    const old = legacyCipher().encryptString('old')
    const cipher = createMigratingCipher(createKeyringCipher(memoryStore()), null)
    assert.throws(() => cipher.decryptString(old), /no legacy cipher/)
    assert.equal(cipher.isEncryptionAvailable(), true)
  })
})
