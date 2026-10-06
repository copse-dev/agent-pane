import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { openPersistentStore } from './persistent-store.ts'
import { runSerialized } from './write-queue.ts'
import { copseUserDataDir } from './copse-paths.ts'
import { perfCount } from '../diagnostics/perf-trace.ts'

// Cache reads in memory (see `@copse/store-kit`'s cached-store.ts for why:
// electron-store re-parses the whole multi-MB config.json on every `.get`,
// which turned hot-loop reads into a startup-hang). Every main-process
// read/write goes through this module, so caching here is sound.
//
// Known limitation (pre-existing): a separate `copse --acp` process shares the
// same config.json with its own ElectronStore; cross-process writes were
// already last-writer-wins on the whole file, and the cache does not change
// that — it only means this process won't observe another process's write to a
// key it has already read. The write-queue serializes only in-process writers.
const cached = openPersistentStore()

// DEBUG BRANCH: config reads are counted, not spanned. The cache below is what
// makes them cheap; if a regression ever removes or bypasses it, the symptom is
// a large *call count* rather than one slow call, and only a counter shows that.
export const storageGet = (key: string): unknown => {
  const start = process.hrtime.bigint()
  const value = cached.get(key)
  perfCount('storage:get', Number(process.hrtime.bigint() - start) / 1e6)
  return value
}

// Fire-and-forget synchronous set (kept for callers that don't read-modify-write
// and don't need ordering guarantees). Prefer `storageUpdate` for any
// read-modify-write so concurrent callers can't drop each other's changes.
export const storageSet = (key: string, value: unknown): void => {
  const start = process.hrtime.bigint()
  cached.set(key, value)
  perfCount('storage:set', Number(process.hrtime.bigint() - start) / 1e6)
}

/**
 * Set several keys in a single config.json rewrite. Each `storageSet` re-serialises
 * and rewrites the whole file synchronously on the main thread, so a caller that
 * changes related keys together must use this rather than looping `storageSet`.
 */
export const storageSetMany = (values: Readonly<Record<string, unknown>>): void => {
  const start = process.hrtime.bigint()
  cached.setMany(values)
  perfCount('storage:set', Number(process.hrtime.bigint() - start) / 1e6)
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

// Plain files beside config.json, for data that does not belong in it.
//
// Every `storageSet` makes the backing store rewrite the whole config.json on the
// main thread, so anything large or append-only stored there taxes every other
// write: a profile whose config had grown to 10 MB (build logs, a 90-day usage
// ledger) paid ~100 ms of frozen main thread per `storage:set`. Keep such data in
// its own file under the profile's user-data directory instead. All of it is
// asynchronous (the main process must not block on disk). Paths are relative,
// `/`-separated and resolved at call time (so a profile override set later still
// applies); the test shim keeps them in memory, like config values.

const SAFE_FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function userDataFilePath(relPath: string): string {
  const segments = relPath.split('/')
  if (!segments.every((segment) => SAFE_FILE_SEGMENT.test(segment))) {
    throw new Error(`Invalid user-data file path: ${relPath}`)
  }
  return join(copseUserDataDir(), ...segments)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT'
}

/** The file's text, or `null` when it does not exist. */
export async function storageReadFile(relPath: string): Promise<string | null> {
  try {
    return await readFile(userDataFilePath(relPath), 'utf8')
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

/** Append `text` to the file, creating it (and its directory) if needed. */
export async function storageAppendFile(relPath: string, text: string): Promise<void> {
  const path = userDataFilePath(relPath)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, text)
}

/** Replace the file's contents atomically: a reader sees the old text or the new, never half. */
export async function storageWriteFile(relPath: string, text: string): Promise<void> {
  const path = userDataFilePath(relPath)
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${String(process.pid)}.tmp`
  await writeFile(temp, text)
  await rename(temp, path)
}

export async function storageRemoveFile(relPath: string): Promise<void> {
  await rm(userDataFilePath(relPath), { force: true })
}

/** Names of the entries directly inside `relDir` (empty when it does not exist). */
export async function storageListFiles(relDir: string): Promise<string[]> {
  try {
    return await readdir(userDataFilePath(relDir))
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}
