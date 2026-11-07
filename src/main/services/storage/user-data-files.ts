import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { copseUserDataDir } from './copse-paths.ts'

// Plain files beside config.json, for data that does not belong in it.
//
// Every `storageSet` makes the backing store rewrite the whole config.json on the
// main thread, so anything large or append-only stored there taxes every other
// write: a profile whose config had grown to 10 MB (build logs, a 90-day usage
// ledger) paid ~100 ms of frozen main thread per `storage:set`. Keep such data in
// its own file under the profile's user-data directory instead. All of it is
// asynchronous (the main process must not block on disk). Paths are relative,
// `/`-separated and resolved at call time (so a profile override set later still
// applies). Unit tests swap this module for `user-data-files.test-shim.ts`, which
// keeps the files in memory so no test writes to a developer's real profile.

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
