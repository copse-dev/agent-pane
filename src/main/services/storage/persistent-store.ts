import ElectronStore from 'electron-store'
import { createCachedStore, type CachedStore } from './cached-store.ts'

export interface PersistentStoreOptions {
  /** Storage filename without the `.json` extension. Defaults to `config`. */
  name?: string
}

/**
 * Open a cached persistent key-value store.
 *
 * This is the only module that knows electron-store is the disk backend. Keep
 * consumers on the small CachedStore interface so cache-coherent writes and a
 * future backend replacement do not require changes throughout the app.
 */
export function openPersistentStore(options: PersistentStoreOptions = {}): CachedStore {
  const store = new ElectronStore<Record<string, unknown>>(options)
  return createCachedStore({
    get: (key) => store.get(key),
    set: (key, value) => {
      store.set(key, value)
    },
    delete: (key) => {
      store.delete(key)
    },
  })
}
