import ElectronStore from 'electron-store'
import { runSerialized } from './write-queue.ts'

const store = new ElectronStore<Record<string, unknown>>()
export const storageGet = (key: string): unknown => store.get(key)

// Fire-and-forget synchronous set (kept for callers that don't read-modify-write
// and don't need ordering guarantees). Prefer `storageUpdate` for any
// read-modify-write so concurrent callers can't drop each other's changes.
export const storageSet = (key: string, value: unknown): void => {
  store.set(key, value)
}

/**
 * Serialized read-modify-write against a single key. The `update` callback gets
 * the current value and returns the next value to persist. Calls for the same
 * key run strictly one at a time (electron-store's file write is non-atomic), so
 * concurrent callers no longer clobber each other.
 */
export function storageUpdate(key: string, update: (current: unknown) => unknown): Promise<void> {
  return runSerialized(key, () => {
    const next = update(store.get(key))
    store.set(key, next)
  })
}
