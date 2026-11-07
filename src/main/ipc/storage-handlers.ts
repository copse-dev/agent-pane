import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import { defineHandler } from './define-handler.ts'
import { assertStorageKey, zNonEmptyString } from './ipc-guards.ts'
import { inspectStorageMaintenance, saveStorageRetention } from '../services/storage-maintenance.ts'
import { containerStorage } from '../services/container-storage.ts'
import { storageCleanup } from '../services/storage-cleanup.ts'
import { storageGet, storageSet } from '../services/storage/storage.ts'
import {
  containerStorageActionSchema,
  storageAreaSchema,
  storageRetentionSchema,
} from '../../shared/types/storage-cleanup.ts'

const zStorageKey = zNonEmptyString.max(256)

export function registerStorageHandlers(win: BrowserWindow): void {
  defineHandler(win, 'storage:maintenance', z.tuple([]), () => inspectStorageMaintenance())
  defineHandler(win, 'storage:cleanup', z.tuple([storageAreaSchema]), (area) =>
    storageCleanup().clean(area),
  )
  defineHandler(
    win,
    'storage:container-cleanup',
    z.tuple([containerStorageActionSchema]),
    (action) => containerStorage().clean(action),
  )
  defineHandler(win, 'storage:retention', z.tuple([storageRetentionSchema]), (policy) => {
    saveStorageRetention(policy)
  })
  defineHandler(win, 'storage:get', z.tuple([zStorageKey]), (key) => {
    assertStorageKey(key)
    return storageGet(key)
  })
  // The value is stored as sent; only the key is validated, as before.
  defineHandler(
    win,
    'storage:set',
    z.tuple([zStorageKey, z.unknown()]),
    (key, value) => {
      assertStorageKey(key)
      storageSet(key, value)
    },
    { errors: 'per-argument' },
  )
}
