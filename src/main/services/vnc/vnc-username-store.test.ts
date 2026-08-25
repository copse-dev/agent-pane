import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isRecord } from '@shared/unknown-value.ts'
import type { SecretCipher } from '../storage/secret-cipher.ts'
import { registerSecretSweep, resetSecretSweeps } from '../storage/secret-migration.ts'
import type { VncUsernameStoreDependencies } from './vnc-username-store.ts'
import {
  getVncUsername,
  migrateStoredVncUsernames,
  rememberVncUsername,
} from './vnc-username-store.ts'

/** Reads the stored format, writes a newer one — what the keyring cipher is. */
function migratingCipher(): SecretCipher & { encrypts: number } {
  const cipher = {
    encrypts: 0,
    isEncryptionAvailable: (): boolean => true,
    encryptString(plainText: string): Buffer {
      cipher.encrypts += 1
      return Buffer.from(`v2:${plainText}`, 'utf8')
    },
    decryptString(encrypted: Buffer): string {
      const value = encrypted.toString('utf8')
      const prefix = value.startsWith('v2:') ? 'v2:' : 'encrypted:'
      if (!value.startsWith(prefix)) throw new Error('Invalid ciphertext')
      return value.slice(prefix.length)
    },
    shouldReencrypt: (encrypted: Buffer): boolean => !encrypted.toString('utf8').startsWith('v2:'),
  }
  return cipher
}

/** The nested `vncUsername` object the settings store actually persists. */
function nestedRecords(values: Map<string, unknown>): Record<string, unknown> {
  const nested: Record<string, unknown> = {}
  for (const [key, value] of values) {
    if (key.startsWith('vncUsername.')) nested[key.slice('vncUsername.'.length)] = value
  }
  return nested
}

/** Dependencies whose top-level `vncUsername` read mirrors the flat map. */
function sweepable(
  dependencies: VncUsernameStoreDependencies,
  values: Map<string, unknown>,
): VncUsernameStoreDependencies {
  return {
    ...dependencies,
    read: (key: string): unknown =>
      key === 'vncUsername' ? nestedRecords(values) : dependencies.read(key),
  }
}

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

  it('rewrites a legacy-format username through the current cipher on read', async () => {
    const { dependencies, values } = testStore()
    const target = { kind: 'ssh', hostId: 'studio', remotePort: 5900 } as const
    await rememberVncUsername(target, 'studio-user', dependencies)
    const [key, before] = [...values.entries()][0] ?? []
    assert.ok(typeof key === 'string')

    // A cipher that reads the stored format but prefers a new one for writes.
    let encrypts = 0
    const migrating: SecretCipher = {
      isEncryptionAvailable: () => true,
      encryptString: (plainText) => {
        encrypts += 1
        return Buffer.from(`v2:${plainText}`, 'utf8')
      },
      decryptString: (encrypted) => {
        const value = encrypted.toString('utf8')
        const prefix = value.startsWith('v2:') ? 'v2:' : 'encrypted:'
        if (!value.startsWith(prefix)) throw new Error('Invalid ciphertext')
        return value.slice(prefix.length)
      },
      shouldReencrypt: (encrypted) => !encrypted.toString('utf8').startsWith('v2:'),
    }
    const upgraded = { ...dependencies, getCipher: (): SecretCipher => migrating }

    assert.equal(getVncUsername(target, upgraded), 'studio-user')
    await Promise.resolve()
    assert.equal(encrypts, 1)
    assert.notDeepEqual(values.get(key), before)
    assert.match(JSON.stringify(values.get(key)), /"v":1/)

    // Already in the new format: read again, no further rewrite.
    assert.equal(getVncUsername(target, upgraded), 'studio-user')
    assert.equal(encrypts, 1)
  })

  it('sweeps every remembered username once one of them migrates', async () => {
    const { dependencies, values } = testStore()
    const targets = [
      { kind: 'ssh', hostId: 'studio', remotePort: 5900 },
      { kind: 'loopback', port: 5900 },
      { kind: 'network', host: 'rack.local', port: 5900, confirmedUnencrypted: true },
    ] as const
    for (const target of targets) await rememberVncUsername(target, 'studio-user', dependencies)
    assert.equal(values.size, 3)

    const cipher = migratingCipher()
    const upgraded = sweepable({ ...dependencies, getCipher: () => cipher }, values)

    // One read migrates its own record, and the sweep finishes the other two.
    resetSecretSweeps()
    registerSecretSweep(() => {
      migrateStoredVncUsernames(upgraded)
    })
    assert.equal(getVncUsername(targets[0], upgraded), 'studio-user')
    await Promise.resolve()

    assert.equal(cipher.encrypts, 3)
    for (const value of values.values()) {
      assert.ok(isRecord(value) && typeof value['enc'] === 'string')
      assert.ok(Buffer.from(value['enc'], 'base64').toString('utf8').startsWith('v2:'))
    }
  })

  it('leaves a record it cannot decrypt for the machine that can', async () => {
    const { dependencies, values } = testStore()
    const target = { kind: 'ssh', hostId: 'studio', remotePort: 5900 } as const
    await rememberVncUsername(target, 'studio-user', dependencies)
    const foreign = { v: 1, enc: Buffer.from('someone-elses-key', 'utf8').toString('base64') }
    values.set('vncUsername.deadbeef', foreign)

    const cipher = migratingCipher()
    migrateStoredVncUsernames(sweepable({ ...dependencies, getCipher: () => cipher }, values))
    await Promise.resolve()

    assert.equal(cipher.encrypts, 1)
    assert.deepEqual(values.get('vncUsername.deadbeef'), foreign)
  })

  it('asks for a sweep only when a rewrite actually happened', async () => {
    const { dependencies, values } = testStore()
    const target = { kind: 'ssh', hostId: 'studio', remotePort: 5900 } as const
    await rememberVncUsername(target, 'studio-user', dependencies)

    resetSecretSweeps()
    let sweeps = 0
    registerSecretSweep(() => {
      sweeps += 1
    })

    // The stored blob is already in the cipher's own format: nothing to sweep.
    assert.equal(getVncUsername(target, dependencies), 'studio-user')
    assert.equal(sweeps, 0)

    const upgraded = sweepable({ ...dependencies, getCipher: () => migratingCipher() }, values)
    assert.equal(getVncUsername(target, upgraded), 'studio-user')
    assert.equal(sweeps, 1)
  })

  it('still returns the username when the migration rewrite fails', async () => {
    const { dependencies, values } = testStore()
    const target = { kind: 'ssh', hostId: 'studio', remotePort: 5900 } as const
    await rememberVncUsername(target, 'studio-user', dependencies)
    const [key, before] = [...values.entries()][0] ?? []
    assert.ok(typeof key === 'string')
    const base = dependencies.getCipher()
    assert.ok(base)
    const failing: SecretCipher = {
      ...base,
      encryptString: () => Buffer.from('legacy-fallback', 'utf8'),
      encryptStringForMigration: () => {
        throw new Error('keyring write refused')
      },
      shouldReencrypt: () => true,
    }
    assert.equal(
      getVncUsername(target, { ...dependencies, getCipher: (): SecretCipher => failing }),
      'studio-user',
    )
    await Promise.resolve()
    assert.deepEqual(values.get(key), before, 'failed migration must leave the legacy blob intact')
  })
})
