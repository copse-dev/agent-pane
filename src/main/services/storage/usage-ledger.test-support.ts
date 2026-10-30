import { storageListFiles, storageRemoveFile } from './user-data-files.ts'
import { USAGE_EVENTS_DIR } from '@shared/usage/usage-event.ts'

/** Empty the usage ledger between tests (`user-data-files.test-shim.ts` keeps its files in memory). */
export async function clearUsageLedger(): Promise<void> {
  for (const name of await storageListFiles(USAGE_EVENTS_DIR)) {
    await storageRemoveFile(`${USAGE_EVENTS_DIR}/${name}`)
  }
}
