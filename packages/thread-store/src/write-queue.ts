// A keyed serialized write queue. electron-store performs synchronous,
// non-atomic read-modify-write of a single JSON file, so two concurrent async
// callers that each read-then-write the same key can drop one update (the
// classic lost-update race in `rememberMcpTool` / `setMcpServerUserEnabled`).
//
// `runSerialized` chains async write operations per key so they run strictly one
// at a time, in submission order. Different keys run independently. A rejecting
// operation does not poison the chain for later submissions. This is the
// process-wide store write queue that `drainWriteQueue` flushes at shutdown;
// code that wants the same ordering without joining that drain makes its own
// `createKeyedSerialQueue()`.

import { createKeyedSerialQueue } from '@copse/std/keyed-serial-queue.ts'

const writes = createKeyedSerialQueue<string>()

export function runSerialized<T>(key: string, op: () => T | Promise<T>): Promise<T> {
  return writes.run(key, op)
}

/**
 * Serialized read-modify-write for stores whose read must happen after every
 * earlier write settles. Keeping the read inside {@link runSerialized} avoids
 * the stale-snapshot pattern where two callers each append to the same old
 * value and the later write erases the first update.
 */
export function runSerializedUpdate<T>(
  key: string,
  read: () => T,
  update: (current: T) => T,
  write: (next: T) => void | Promise<void>,
): Promise<T> {
  return runSerialized(key, async () => {
    const next = update(read())
    await write(next)
    return next
  })
}

/** Resolve once every currently-queued write, including writes it enqueues, has settled. */
export function drainWriteQueue(): Promise<void> {
  return writes.drain()
}
