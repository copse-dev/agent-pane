import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import { setPersistentStoreFactory } from './persistent-store.ts'
import { getSecretCipher, setSecretCipher, type SecretCipher } from './secret-cipher.ts'
import { runWithExplicitSettings } from './settings-context.ts'
import { seedHandEditedSetting } from './settings.test-support.ts'
import { deleteApiKey, isApiKeyReadable, isProviderAvailable, resolveApiKey } from './settings.ts'

const PROVIDER = 'openai'
const KEY = `apiKey.${PROVIDER}`
const values = new Map<string, unknown>()
const previousCipher = getSecretCipher()
const previousEnv = process.env['OPENAI_API_KEY']

function installCipher(
  available: () => boolean,
  decrypt: (encrypted: Buffer) => string = (encrypted) => encrypted.toString('utf8'),
): { availability: number; decrypt: number } {
  const calls = { availability: 0, decrypt: 0 }
  const cipher: SecretCipher = {
    isEncryptionAvailable(): boolean {
      calls.availability += 1
      return available()
    },
    encryptString: (plainText) => Buffer.from(plainText, 'utf8'),
    decryptString(encrypted): string {
      calls.decrypt += 1
      return decrypt(encrypted)
    },
  }
  setSecretCipher(cipher)
  return calls
}

function forbidKeyring(): boolean {
  throw new Error('This record must not query OS encryption availability')
}

describe('actual settings API-key readability keyring boundary', () => {
  before(() => {
    // Use the product's existing store/cipher injection boundaries. No Electron,
    // OS credential store, or substitute settings implementation is involved.
    setPersistentStoreFactory(() => ({
      get: (key): unknown => values.get(key),
      set: (key, value): void => {
        values.set(key, structuredClone(value))
      },
      delete: (key): void => {
        values.delete(key)
      },
      deleteKeys: (keys): void => {
        for (const key of keys) values.delete(key)
      },
      listKeys: (): string[] => [...values.keys()],
    }))
  })
  beforeEach(() => {
    Reflect.deleteProperty(process.env, 'OPENAI_API_KEY')
    deleteApiKey(PROVIDER)
    setSecretCipher(null)
  })
  afterEach(() => {
    setSecretCipher(null)
    deleteApiKey(PROVIDER)
    values.clear()
    if (previousEnv === undefined) Reflect.deleteProperty(process.env, 'OPENAI_API_KEY')
    else process.env['OPENAI_API_KEY'] = previousEnv
  })
  after(() => {
    setSecretCipher(previousCipher)
    setPersistentStoreFactory(null)
  })

  const malformed: Array<{ label: string; value: unknown }> = [
    { label: 'absent', value: undefined },
    { label: 'null', value: null },
    { label: 'legacy string', value: 'not a stored record' },
    { label: 'array', value: [] },
    { label: 'wrong version', value: { v: 2, enc: 'encoded' } },
    { label: 'non-string ciphertext', value: { v: 1, enc: 7 } },
    { label: 'non-boolean plaintext marker', value: { v: 1, enc: 'encoded', plain: 'true' } },
  ]
  for (const entry of malformed) {
    it(`does not query the keyring for an ${entry.label} record`, async () => {
      if (entry.value !== undefined) await seedHandEditedSetting(KEY, entry.value)
      const calls = installCipher(forbidKeyring)
      assert.equal(isApiKeyReadable(PROVIDER), null)
      assert.equal(isProviderAvailable(PROVIDER), false)
      assert.deepEqual(calls, { availability: 0, decrypt: 0 })
    })
  }
  for (const plain of [false, true]) {
    it(`does not query the keyring for empty ${plain ? 'plaintext' : 'encrypted'} data`, async () => {
      await seedHandEditedSetting(KEY, { v: 1, enc: '', plain })
      const calls = installCipher(forbidKeyring)
      assert.equal(isApiKeyReadable(PROVIDER), null)
      assert.deepEqual(calls, { availability: 0, decrypt: 0 })
    })
  }
  it('does not query the keyring for a readable plaintext record', async () => {
    await seedHandEditedSetting(KEY, {
      v: 1,
      enc: Buffer.from('fixture-plaintext').toString('base64'),
      plain: true,
    })
    const calls = installCipher(forbidKeyring)
    assert.equal(isApiKeyReadable(PROVIDER), true)
    assert.equal(isProviderAvailable(PROVIDER), true)
    assert.equal(resolveApiKey(PROVIDER), 'fixture-plaintext')
    assert.deepEqual(calls, { availability: 0, decrypt: 0 })
  })

  it('probes encrypted readability and caches decryption for unchanged ciphertext', async () => {
    await seedHandEditedSetting(KEY, {
      v: 1,
      enc: Buffer.from('fixture-secret').toString('base64'),
    })
    const calls = installCipher(() => true)
    assert.equal(isApiKeyReadable(PROVIDER), true)
    assert.equal(isApiKeyReadable(PROVIDER), true)
    assert.deepEqual(calls, { availability: 2, decrypt: 1 })
  })
  it('keeps encrypted readability unknown when the OS cipher is unavailable', async () => {
    await seedHandEditedSetting(KEY, { v: 1, enc: 'encoded' })
    const calls = installCipher(() => false)
    assert.equal(isApiKeyReadable(PROVIDER), true)
    assert.deepEqual(calls, { availability: 1, decrypt: 0 })
  })
  it('reports corrupt encrypted data unreadable and caches the failed decryption', async () => {
    await seedHandEditedSetting(KEY, { v: 1, enc: 'corrupt' })
    const calls = installCipher(
      () => true,
      () => {
        throw new Error('fixture decryption failed')
      },
    )
    assert.equal(isApiKeyReadable(PROVIDER), false)
    assert.equal(isApiKeyReadable(PROVIDER), false)
    assert.deepEqual(calls, { availability: 2, decrypt: 1 })
  })
  it('rechecks readability after the encrypted record changes', async () => {
    await seedHandEditedSetting(KEY, { v: 1, enc: Buffer.from('first').toString('base64') })
    const calls = installCipher(
      () => true,
      (encrypted) => {
        if (encrypted.toString('utf8') === 'first') throw new Error('first record is corrupt')
        return 'second-secret'
      },
    )
    assert.equal(isApiKeyReadable(PROVIDER), false)
    await seedHandEditedSetting(KEY, { v: 1, enc: Buffer.from('second').toString('base64') })
    assert.equal(isApiKeyReadable(PROVIDER), true)
    assert.deepEqual(calls, { availability: 2, decrypt: 2 })
  })
  it('preserves the environment fallback without consulting the keyring', () => {
    process.env['OPENAI_API_KEY'] = 'fixture-environment-key'
    const calls = installCipher(forbidKeyring)
    assert.equal(resolveApiKey(PROVIDER), 'fixture-environment-key')
    assert.equal(isProviderAvailable(PROVIDER), true)
    assert.deepEqual(calls, { availability: 0, decrypt: 0 })
  })
  it('keeps explicit profiles independent of ambient storage and keys', () => {
    process.env['OPENAI_API_KEY'] = 'ambient-fixture-key'
    const calls = installCipher(forbidKeyring)
    runWithExplicitSettings({ values: {} }, () => {
      assert.equal(isApiKeyReadable(PROVIDER), null)
      assert.equal(isProviderAvailable(PROVIDER), false)
      assert.equal(resolveApiKey(PROVIDER), null)
    })
    runWithExplicitSettings({ values: {}, apiKeys: { openai: 'scoped-fixture-key' } }, () => {
      assert.equal(isApiKeyReadable(PROVIDER), true)
      assert.equal(resolveApiKey(PROVIDER), 'scoped-fixture-key')
    })
    assert.deepEqual(calls, { availability: 0, decrypt: 0 })
  })
})
