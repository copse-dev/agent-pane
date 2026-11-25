import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BackingStore } from '@copse/store-kit/cached-store.ts'
import type { PersistentStoreFactory } from '../storage/persistent-store.ts'
import { isRecord } from '@shared/unknown-value.ts'

/**
 * The profile's key-value stores (`config.json` and friends) as the turn worker
 * sees them (`docs/plans/local-turn-worker.md` decision 4).
 *
 * Each store is one JSON file that every process caches and rewrites whole, so a
 * second writer would silently drop the desktop's changes. The worker reads the
 * files once at start ({@link readProfileStores}), keeps anything it sets in
 * memory for the rest of its run, and never writes them. `onWrite` hears each key it would have written, once, so the
 * log shows what a handed-off turn could not keep.
 */
export function readOnlyProfileStoreFactory(
  stores: ReadonlyMap<string, Record<string, unknown>>,
  onWrite: (store: string, key: string) => void = (): void => undefined,
): PersistentStoreFactory {
  return (options) => {
    const name = options.name ?? 'config'
    const values = new Map<string, unknown>(Object.entries(structuredClone(stores.get(name) ?? {})))
    const reported = new Set<string>()
    const noteWrite = (key: string): void => {
      if (reported.has(key)) return
      reported.add(key)
      onWrite(name, key)
    }
    const backing: BackingStore = {
      get: (key): unknown => values.get(key),
      set: (key, value): void => {
        noteWrite(key)
        values.set(key, structuredClone(value))
      },
      setMany: (patch): void => {
        for (const [key, value] of Object.entries(patch)) backing.set(key, value)
      },
      delete: (key): void => {
        noteWrite(key)
        values.delete(key)
      },
      listKeys: (): string[] => [...values.keys()],
      deleteKeys: (keys): void => {
        for (const key of keys) backing.delete(key)
      },
    }
    return backing
  }
}

/**
 * Every store file at the top of the profile, by store name. A file that is
 * missing, unreadable or not a JSON object reads as an empty store.
 */
export async function readProfileStores(
  userDataPath: string,
): Promise<Map<string, Record<string, unknown>>> {
  const stores = new Map<string, Record<string, unknown>>()
  let names: string[]
  try {
    names = await readdir(userDataPath)
  } catch {
    return stores
  }
  for (const file of names) {
    if (!file.endsWith('.json')) continue
    try {
      const parsed: unknown = JSON.parse(await readFile(join(userDataPath, file), 'utf8'))
      if (isRecord(parsed)) stores.set(file.slice(0, -'.json'.length), parsed)
    } catch {
      // Not a store this worker can read; it starts empty.
    }
  }
  return stores
}
