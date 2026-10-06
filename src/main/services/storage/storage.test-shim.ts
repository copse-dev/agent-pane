import { runSerialized } from './write-queue.ts'

const mem = new Map<string, unknown>()
/** One per operation that would rewrite the backing file: a batch counts once. */
let backingWrites = 0

export function storageGet(key: string): unknown {
  return mem.get(key)
}

export function storageSet(key: string, value: unknown): void {
  backingWrites += 1
  mem.set(key, value)
}

export function storageSetMany(values: Readonly<Record<string, unknown>>): void {
  backingWrites += 1
  for (const [key, value] of Object.entries(values)) mem.set(key, value)
}

export function storageDelete(key: string): void {
  backingWrites += 1
  mem.delete(key)
}

export function storageListKeys(): string[] {
  return [...mem.keys()]
}

export function storageDeleteKeys(keys: string[]): void {
  backingWrites += 1
  for (const key of keys) mem.delete(key)
}

export function storageBackingWrites(): number {
  return backingWrites
}

export function storageUpdate(key: string, update: (current: unknown) => unknown): Promise<void> {
  return runSerialized(key, () => {
    backingWrites += 1
    mem.set(key, update(mem.get(key)))
  })
}

// In-memory stand-ins for the user-data file helpers in storage.ts, so no test
// writes to a developer's real profile. They return promises like the real ones,
// but apply their effect immediately, before the promise is handed back.
const files = new Map<string, string>()

const SAFE_FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function checkedFilePath(relPath: string): string {
  if (!relPath.split('/').every((segment) => SAFE_FILE_SEGMENT.test(segment))) {
    throw new Error(`Invalid user-data file path: ${relPath}`)
  }
  return relPath
}

export function storageReadFile(relPath: string): Promise<string | null> {
  return Promise.resolve(files.get(checkedFilePath(relPath)) ?? null)
}

export function storageAppendFile(relPath: string, text: string): Promise<void> {
  const path = checkedFilePath(relPath)
  files.set(path, (files.get(path) ?? '') + text)
  return Promise.resolve()
}

export function storageWriteFile(relPath: string, text: string): Promise<void> {
  files.set(checkedFilePath(relPath), text)
  return Promise.resolve()
}

export function storageRemoveFile(relPath: string): Promise<void> {
  files.delete(checkedFilePath(relPath))
  return Promise.resolve()
}

export function storageListFiles(relDir: string): Promise<string[]> {
  const prefix = `${checkedFilePath(relDir)}/`
  return Promise.resolve(
    [...files.keys()]
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map((path) => path.slice(prefix.length)),
  )
}
