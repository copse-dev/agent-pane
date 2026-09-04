import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { openPersistentStore, setPersistentStoreFactory } from './persistent-store.ts'

afterEach(() => {
  setPersistentStoreFactory(null)
})

describe('persistent-store runtime backend', () => {
  it('uses a shared in-memory store when Electron has not installed a backend', () => {
    const name = `headless-${randomUUID()}`
    const first = openPersistentStore({ name })
    const second = openPersistentStore({ name })

    first.set('model', 'mock')
    assert.equal(second.get('model'), 'mock')
  })

  it('uses the backend factory installed by the Electron entry point', () => {
    const values = new Map<string, unknown>()
    let requestedName: string | undefined
    setPersistentStoreFactory((options) => {
      requestedName = options.name
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
          for (const key of keys) values.delete(key)
        },
      }
    })

    const store = openPersistentStore({ name: 'settings' })
    store.set('theme', 'dark')

    assert.equal(requestedName, 'settings')
    assert.equal(values.get('theme'), 'dark')
  })
})
