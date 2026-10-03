import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setPersistentStoreFactory } from '../storage/persistent-store.ts'
import { setSecretCipher } from '../storage/secret-cipher.ts'
import { createChatGptPlanStore } from './chatgpt-plan-store.ts'
import { isSecretSettingKey, isRendererWritableSettingKey } from '../storage/settings-writable.ts'

afterEach(() => {
  setSecretCipher(null)
  setPersistentStoreFactory(null)
})

describe('ChatGPT credential storage', () => {
  it('refuses plaintext storage and prevents generic renderer reads/writes', () => {
    setSecretCipher(null)
    const store = createChatGptPlanStore()
    assert.throws(() => {
      store.write(store.read())
    }, /Secure storage/)
    assert.equal(isSecretSettingKey('chatgptPlanCredentials'), true)
    assert.equal(isRendererWritableSettingKey('chatgptPlanCredentials'), false)
  })

  it('encrypts the whole record in settings and validates decrypted JSON before use', () => {
    const values = new Map<string, unknown>()
    setPersistentStoreFactory((options) => {
      assert.equal(options.name, 'settings')
      return {
        get: (key): unknown => values.get(key),
        set: (key, value): void => {
          values.set(key, value)
        },
        delete: (key): void => {
          values.delete(key)
        },
        listKeys: (): string[] => [...values.keys()],
        deleteKeys: (keys): void => {
          keys.forEach((key) => {
            values.delete(key)
          })
        },
      }
    })
    // Inject the cipher at the existing OS-storage boundary, never a product flag.
    setSecretCipher({
      isEncryptionAvailable: (): boolean => true,
      encryptString: (text): Buffer =>
        Buffer.from([...Buffer.from(text)].map((byte) => byte ^ 0x55)),
      decryptString: (bytes): string =>
        Buffer.from([...bytes].map((byte) => byte ^ 0x55)).toString('utf8'),
    })
    const store = createChatGptPlanStore()
    const state = store.read()
    state.accounts.push({
      clientId: 'client',
      label: 'Account',
      subject: 'sub',
      credentials: {
        accessToken: 'secret-access',
        refreshToken: 'secret-refresh',
        idToken: 'secret-id',
        scopes: ['chatgpt.tokens.use.direct'],
        expiresAt: 123,
      },
    })
    store.write(state)
    assert.deepEqual(createChatGptPlanStore().read(), state)
    assert.equal(JSON.stringify([...values.values()]).includes('secret-access'), false)
    values.set('chatgptPlanCredentials', Buffer.from('invalid plaintext').toString('base64'))
    assert.throws(() => createChatGptPlanStore().read(), /invalid/)
  })
})
