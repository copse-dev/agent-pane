import { ipcMain, type BrowserWindow } from 'electron'
import {
  assertMainFrameSender,
  assertStorageKey,
  parseIpcArgs,
  zNonEmptyString,
} from './ipc-guards.ts'
import { inspectStorageMaintenance, saveStorageRetention } from '../services/storage-maintenance.ts'
import { containerStorage } from '../services/container-storage.ts'
import { storageCleanup } from '../services/storage-cleanup.ts'
import { storageGet, storageSet } from '../services/storage/storage.ts'
import {
  containerStorageActionSchema,
  storageAreaSchema,
  storageRetentionSchema,
} from '../../shared/types/storage-cleanup.ts'

export function registerStorageHandlers(win: BrowserWindow): void {
  ipcMain.handle('storage:maintenance', (event) => {
    assertMainFrameSender(event, win)
    return inspectStorageMaintenance()
  })
  ipcMain.handle('storage:cleanup', (event, area: unknown) => {
    assertMainFrameSender(event, win)
    return storageCleanup().clean(parseIpcArgs(storageAreaSchema, [area]))
  })
  ipcMain.handle('storage:container-cleanup', (event, action: unknown) => {
    assertMainFrameSender(event, win)
    return containerStorage().clean(parseIpcArgs(containerStorageActionSchema, [action]))
  })
  ipcMain.handle('storage:retention', (event, policy: unknown) => {
    assertMainFrameSender(event, win)
    saveStorageRetention(parseIpcArgs(storageRetentionSchema, [policy]))
  })
  ipcMain.handle('storage:get', (event, key: unknown) => {
    assertMainFrameSender(event, win)
    const k = parseIpcArgs(zNonEmptyString.max(256), [key])
    assertStorageKey(k)
    return storageGet(k)
  })
  ipcMain.handle('storage:set', (event, key: unknown, value: unknown) => {
    assertMainFrameSender(event, win)
    const k = parseIpcArgs(zNonEmptyString.max(256), [key])
    assertStorageKey(k)
    storageSet(k, value)
  })
}
