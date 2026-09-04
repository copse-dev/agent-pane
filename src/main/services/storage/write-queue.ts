// The per-key write serializer lives in `@copse/thread-store` (the store is its
// heaviest user and must share one queue with every other writer of the same
// paths). Re-exported so `drainWriteQueue` and `runSerialized` keep their import.
export * from '@copse/thread-store/write-queue.ts'
