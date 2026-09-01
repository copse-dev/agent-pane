import { runSerialized } from '../storage/write-queue.ts'

interface PermissionValueStore {
  read: () => readonly string[]
  write: (values: readonly string[]) => Promise<void>
}

/** Add one remembered permission value without duplicating an existing grant. */
export async function rememberPermissionValue(
  key: string,
  value: string,
  store: PermissionValueStore,
): Promise<void> {
  await runSerialized(`permission-memory:${key}`, async () => {
    const current = store.read()
    if (current.includes(value)) return
    await store.write([...current, value])
  })
}
