import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createKeyringCipher } from './keyring-cipher.ts'
import { setPersistentStoreFactory } from './persistent-store.ts'
import { storedKeysOpenOutsideApp } from './settings.ts'

// The app's backend keeps every API key in one nested `apiKey` record and
// lists top-level keys only (`electron-store-backend.ts`); this does the same.
// The settings cache keeps the record it first read, so each case refills it.
const apiKey: Record<string, unknown> = {}

function storeKeys(keys: Record<string, unknown>): void {
  for (const key of Object.keys(apiKey)) Reflect.deleteProperty(apiKey, key)
  Object.assign(apiKey, keys)
}

function stored(blob: Buffer): { v: 1; enc: string } {
  return { v: 1, enc: blob.toString('base64') }
}

describe('storedKeysOpenOutsideApp', () => {
  before(() => {
    setPersistentStoreFactory(() => ({
      get: (key): unknown => (key === 'apiKey' ? apiKey : undefined),
      set: (): void => undefined,
      delete: (): void => undefined,
      deleteKeys: (): void => undefined,
      listKeys: (): string[] => ['apiKey'],
    }))
  })
  after(() => {
    setPersistentStoreFactory(null)
  })

  it('is true when every stored key is plain or sealed by the keyring cipher', () => {
    let dataKey: string | null = null
    const keyring = createKeyringCipher({
      read: () => dataKey,
      write: (value) => {
        dataKey = value
      },
    })
    storeKeys({
      anthropic: stored(keyring.encryptString('sk-ant')),
      lmstudio: { v: 1, enc: Buffer.from('local').toString('base64'), plain: true },
    })
    assert.equal(storedKeysOpenOutsideApp(), true)
  })

  it('is false when a stored key is a blob only safeStorage can open', () => {
    storeKeys({ openai: stored(Buffer.from('v10 sealed by safeStorage')) })
    assert.equal(storedKeysOpenOutsideApp(), false)
  })
})
