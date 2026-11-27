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
    const root: Record<string, unknown> = structuredClone(stores.get(name) ?? {})
    const reported = new Set<string>()
    const noteWrite = (key: string): void => {
      if (reported.has(key)) return
      reported.add(key)
      onWrite(name, key)
    }
    // As electron-store's: `get`, `set` and `delete` take a dotted path
    // (`apiKey.anthropic` is a field of the one `apiKey` object), while
    // `setMany`, `listKeys` and `deleteKeys` work on top-level keys.
    const backing: BackingStore = {
      get: (key): unknown => getPath(root, key),
      set: (key, value): void => {
        noteWrite(key)
        setPath(root, key, structuredClone(value))
      },
      setMany: (patch): void => {
        for (const [key, value] of Object.entries(patch)) {
          noteWrite(key)
          root[key] = structuredClone(value)
        }
      },
      delete: (key): void => {
        noteWrite(key)
        deletePath(root, key)
      },
      listKeys: (): string[] => Object.keys(root),
      deleteKeys: (keys): void => {
        for (const key of keys) {
          noteWrite(key)
          Reflect.deleteProperty(root, key)
        }
      },
    }
    return backing
  }
}

function getPath(root: Record<string, unknown>, path: string): unknown {
  let node: unknown = root
  for (const part of path.split('.')) {
    if (!isRecord(node)) return undefined
    node = node[part]
  }
  return node
}

/** The object at `parts`, made where it is missing or not an object. */
function parentOf(
  root: Record<string, unknown>,
  parts: readonly string[],
): Record<string, unknown> {
  let node = root
  for (const part of parts) {
    const next = node[part]
    if (isRecord(next)) node = next
    else {
      const made: Record<string, unknown> = {}
      node[part] = made
      node = made
    }
  }
  return node
}

function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  const last = parts.pop() ?? path
  parentOf(root, parts)[last] = value
}

function deletePath(root: Record<string, unknown>, path: string): void {
  const parts = path.split('.')
  const last = parts.pop() ?? path
  const parent = getPath(root, parts.join('.'))
  const target = parts.length === 0 ? root : parent
  if (isRecord(target)) Reflect.deleteProperty(target, last)
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
