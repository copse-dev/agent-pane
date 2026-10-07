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
