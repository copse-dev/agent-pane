import {
  storageRetentionSchema,
  type StorageMaintenanceState,
  type StorageRetention,
} from '../../shared/types/storage-cleanup.ts'
import { storageGet, storageSet } from './storage/storage.ts'
import { storageCleanup } from './storage-cleanup.ts'

const KEY = 'storageRetention'
export function readStorageRetention(): StorageRetention {
  const stored = storageGet(KEY)
  if (stored === undefined) return { enabled: true, days: 30 }
  const parsed = storageRetentionSchema.safeParse(stored)
  return parsed.success ? parsed.data : { enabled: false, days: 30 }
}
export function saveStorageRetention(policy: StorageRetention): void {
  storageSet(KEY, storageRetentionSchema.parse(policy))
}
export async function inspectStorageMaintenance(): Promise<StorageMaintenanceState> {
  const cleanup = storageCleanup()
  return {
    retention: readStorageRetention(),
    areas: await Promise.all([cleanup.inspect('runs'), cleanup.inspect('builds')]),
  }
}
export async function expireStorageData(): Promise<void> {
  const policy = readStorageRetention()
  if (!policy.enabled) return
  const cutoff = Date.now() - policy.days * 86_400_000
  for (const area of ['runs', 'builds'] as const) await storageCleanup().clean(area, cutoff)
}
/** Startup and daily upkeep; errors are visible in diagnostics, never fatal to app startup. */
export function startStorageMaintenance(): void {
  const sweep = (): void => {
    void expireStorageData().catch((error: unknown) => {
      console.warn('[storage-cleanup] Expiry failed', error)
    })
  }
  sweep()
  const timer = setInterval(sweep, 86_400_000)
  timer.unref()
}
