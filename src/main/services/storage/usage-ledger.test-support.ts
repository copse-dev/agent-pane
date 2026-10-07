import { storageListFiles, storageRemoveFile } from './storage.ts'
import { USAGE_EVENTS_DIR } from '@shared/usage/usage-event.ts'

/** Empty the usage ledger between tests (the storage shim keeps its files in memory). */
export async function clearUsageLedger(): Promise<void> {
  for (const name of await storageListFiles(USAGE_EVENTS_DIR)) {
    await storageRemoveFile(`${USAGE_EVENTS_DIR}/${name}`)
  }
}
