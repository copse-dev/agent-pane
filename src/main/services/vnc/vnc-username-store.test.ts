import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SecretCipher } from '../storage/secret-cipher.ts'
import type { VncUsernameStoreDependencies } from './vnc-username-store.ts'
import { getVncUsername, rememberVncUsername } from './vnc-username-store.ts'

function testStore(encryptionAvailable = true): {
  dependencies: VncUsernameStoreDependencies
  values: Map<string, unknown>
} {
  const values = new Map<string, unknown>()
  const cipher: SecretCipher = {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (plainText) => Buffer.from(`encrypted:${plainText}`, 'utf8'),
    decryptString: (encrypted) => {
      const value = encrypted.toString('utf8')
      if (!value.startsWith('encrypted:')) throw new Error('Invalid ciphertext')
      return value.slice('encrypted:'.length)
    },
  }
  return {
    values,
    dependencies: {
      getCipher: () => cipher,
      read: (key) => values.get(key),
      write: (key, value): Promise<void> => {
        values.set(key, value)
        return Promise.resolve()
      },
    },
  }
}

describe('encrypted VNC usernames', () => {
  it('round-trips an encrypted username without persisting plaintext', async () => {
    const { dependencies, values } = testStore()
    const target = { kind: 'ssh', hostId: 'studio', remotePort: 5900 } as const

    assert.equal(await rememberVncUsername(target, '  screen-user  ', dependencies), true)
    assert.equal(getVncUsername(target, dependencies), 'screen-user')
    assert.doesNotMatch(JSON.stringify([...values.values()]), /screen-user/)
  })

  it('keys usernames to a machine rather than its current screen-sharing port', async () => {
    const { dependencies } = testStore()
    await rememberVncUsername(
      { kind: 'network', host: 'Studio.local.', port: 5900, confirmedUnencrypted: true },
      'studio-user',
      dependencies,
    )

    assert.equal(
      getVncUsername(
        { kind: 'network', host: 'studio.local', port: 5999, confirmedUnencrypted: true },
        dependencies,
      ),
      'studio-user',
    )
  })

  it('refuses to persist when OS-backed encryption is unavailable', async () => {
    const { dependencies, values } = testStore(false)
    const saved = await rememberVncUsername(
      { kind: 'loopback', port: 5900 },
      'local-user',
      dependencies,
    )

    assert.equal(saved, false)
    assert.equal(values.size, 0)
  })

  it('ignores ciphertext that cannot be decrypted', async () => {
    const { dependencies, values } = testStore()
    const target = { kind: 'loopback', port: 5900 } as const
    await rememberVncUsername(target, 'local-user', dependencies)
    const key = values.keys().next().value
    assert.equal(typeof key, 'string')
    values.set(key ?? '', {
      v: 1,
      enc: Buffer.from('not-valid', 'utf8').toString('base64'),
      plainTextShouldBeIgnored: 'local-user',
    })

    assert.equal(getVncUsername(target, dependencies), null)
  })

  it('does not treat a plaintext-looking record as a stored username', () => {
    const { dependencies } = testStore()
    const plaintextDependencies: VncUsernameStoreDependencies = {
      ...dependencies,
      read: () => ({ v: 1, username: 'local-user' }),
    }

    assert.equal(
      getVncUsername({ kind: 'ssh', hostId: 'missing', remotePort: 5900 }, plaintextDependencies),
      null,
    )
  })
})
