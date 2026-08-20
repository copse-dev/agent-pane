import { openPersistentStore } from './persistent-store.ts'
import { runSerialized } from './write-queue.ts'

// Cache reads in memory (see cached-store.ts for why: electron-store re-parses
// the whole multi-MB config.json on every `.get`, which turned hot-loop reads
// into a startup-hang). Every main-process read/write goes through this module,
// so caching here is sound.
//
// Known limitation (pre-existing): a separate `copse --acp` process shares the
// same config.json with its own ElectronStore; cross-process writes were
// already last-writer-wins on the whole file, and the cache does not change
// that — it only means this process won't observe another process's write to a
// key it has already read. The write-queue serializes only in-process writers.
const cached = openPersistentStore()

export const storageGet = (key: string): unknown => cached.get(key)

// Fire-and-forget synchronous set (kept for callers that don't read-modify-write
// and don't need ordering guarantees). Prefer `storageUpdate` for any
// read-modify-write so concurrent callers can't drop each other's changes.
export const storageSet = (key: string, value: unknown): void => {
  cached.set(key, value)
}

export const storageDelete = (key: string): void => {
  cached.delete(key)
}

/** Every key currently in the persistent store (for migrations). */
export const storageListKeys = (): string[] => cached.listKeys()

/**
 * Delete many keys in a single config.json rewrite. Prefer this over looping
 * `storageDelete` when finishing a bulk migration (#993).
 */
export const storageDeleteKeys = (keys: string[]): void => {
  cached.deleteKeys(keys)
}

/** Test/diagnostic: how many write/delete ops reached the backing store. */
export const storageBackingWrites = (): number => cached.backingWrites()

/**
 * Serialized read-modify-write against a single key. The `update` callback gets
 * the current value and returns the next value to persist. Calls for the same
 * key run strictly one at a time (electron-store's file write is non-atomic), so
 * concurrent callers no longer clobber each other.
 */
export function storageUpdate(key: string, update: (current: unknown) => unknown): Promise<void> {
  return runSerialized(key, () => {
    cached.set(key, update(cached.get(key)))
  })
}
