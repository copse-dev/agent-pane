const mem = new Map<string, unknown>()

export function storageGet(key: string): unknown {
  return mem.get(key)
}

export function storageSet(key: string, value: unknown): void {
  mem.set(key, value)
}
