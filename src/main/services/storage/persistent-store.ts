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
    listKeys: () => Object.keys(store.store),
    deleteKeys: (keys) => {
      if (keys.length === 0) return
      // Assigning `.store` replaces the whole config in one atomic write (Conf /
      // electron-store). Looping `delete` would rewrite config.json once per key
      // and recreate the multi-MB startup amplification #993 removes.
      const drop = new Set(keys)
      const next: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(store.store)) {
        if (!drop.has(key)) next[key] = value
      }
      store.store = next
    },
  })
}
