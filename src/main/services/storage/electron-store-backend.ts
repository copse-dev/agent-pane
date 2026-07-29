import ElectronStore from 'electron-store'
import { setPersistentStoreFactory } from './persistent-store.ts'

/** Install electron-store after app-init has fixed Electron's userData path. */
export function installElectronStoreBackend(): void {
  setPersistentStoreFactory((options) => {
    const store = new ElectronStore<Record<string, unknown>>(options)
    return {
      get: (key): unknown => store.get(key),
      set: (key, value): void => {
        store.set(key, value)
      },
      delete: (key): void => {
        store.delete(key)
      },
      listKeys: (): string[] => Object.keys(store.store),
      deleteKeys: (keys): void => {
        if (keys.length === 0) return
        // Assigning `.store` replaces the whole config in one atomic write.
        // Looping `delete` would rewrite config.json once per key and recreate
        // the multi-MB startup amplification #993 removes.
        const drop = new Set(keys)
        const next: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(store.store)) {
          if (!drop.has(key)) next[key] = value
        }
        store.store = next
      },
    }
  })
}
