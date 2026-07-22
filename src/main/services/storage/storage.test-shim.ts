import { runSerialized } from './write-queue.ts'

const mem = new Map<string, unknown>()

export function storageGet(key: string): unknown {
  return mem.get(key)
}

export function storageSet(key: string, value: unknown): void {
  mem.set(key, value)
}

export function storageDelete(key: string): void {
  mem.delete(key)
}

export function storageListKeys(): string[] {
  return [...mem.keys()]
}

export function storageDeleteKeys(keys: string[]): void {
  for (const key of keys) mem.delete(key)
}

export function storageBackingWrites(): number {
  return 0
}

export function storageUpdate(key: string, update: (current: unknown) => unknown): Promise<void> {
  return runSerialized(key, () => {
    mem.set(key, update(mem.get(key)))
  })
}
