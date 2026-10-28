import { createCachedStore, type BackingStore, type CachedStore } from './cached-store.ts'

export interface PersistentStoreOptions {
  /** Storage filename without the `.json` extension. Defaults to `config`. */
  name?: string
}

export type PersistentStoreFactory = (options: PersistentStoreOptions) => BackingStore

let factory: PersistentStoreFactory | null = null

/** Install the desktop persistence backend before the first store is opened. */
export function setPersistentStoreFactory(next: PersistentStoreFactory | null): void {
  factory = next
}

// A plain Node importer has no Electron userData directory. Keep module loading
// deterministic and side-effect free until a headless host supplies explicit
// settings; stores with the same name still share values within this process.
const headlessStores = new Map<string, Map<string, unknown>>()

function headlessBacking(options: PersistentStoreOptions): BackingStore {
  const name = options.name ?? 'config'
  let values = headlessStores.get(name)
  if (!values) {
    values = new Map()
    headlessStores.set(name, values)
  }
  const store = values
  return {
    get: (key): unknown => store.get(key),
    set: (key, value): void => {
      store.set(key, structuredClone(value))
    },
    setMany: (values): void => {
      const entries = structuredClone(Object.entries(values))
      for (const [key, value] of entries) store.set(key, value)
    },
    delete: (key): void => {
      store.delete(key)
    },
    listKeys: (): string[] => [...store.keys()],
    deleteKeys: (keys): void => {
      for (const key of keys) store.delete(key)
    },
  }
}

/**
 * Open a cached persistent key-value store.
 *
 * This is the only module that knows electron-store is the disk backend. Keep
 * consumers on the small CachedStore interface so cache-coherent writes and a
 * future backend replacement do not require changes throughout the app.
 */
export function openPersistentStore(options: PersistentStoreOptions = {}): CachedStore {
  return createCachedStore(factory?.(options) ?? headlessBacking(options))
}

/**
 * A store that opens on first use rather than when its module loads.
 *
 * A module-level `openPersistentStore()` binds whichever backend is installed at
 * import time, so the Electron entry point had to win an import-order race
 * before any store module was evaluated, and a store imported earlier silently
 * kept the in-memory backend. Deferring the open moves that binding to the
 * first read or write, which startup already sequences after the backend is
 * installed. Once opened, the backend stays bound for the process.
 */
export function lazyPersistentStore(options: PersistentStoreOptions = {}): CachedStore {
  let store: CachedStore | null = null
  const open = (): CachedStore => (store ??= openPersistentStore(options))
  return {
    get: (key): unknown => open().get(key),
    set: (key, value): void => {
      open().set(key, value)
    },
    setMany: (values): void => {
      open().setMany(values)
    },
    delete: (key): void => {
      open().delete(key)
    },
    listKeys: (): string[] => open().listKeys(),
    deleteKeys: (keys): void => {
      open().deleteKeys(keys)
    },
    backingReads: (): number => open().backingReads(),
    backingWrites: (): number => open().backingWrites(),
  }
}
