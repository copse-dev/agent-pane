import { ipcMain, type BrowserWindow } from 'electron'
import { classifierProfileSchema } from '@copse/llm/classifiers/schemas.ts'
import { assertMainFrameSender, keyProviderSchema, parseIpcArgs } from './ipc-guards.ts'
import {
  backgroundClassifierId,
  getClassifierProfile,
  listClassifierProfiles,
  saveClassifierProfile,
  removeClassifierProfile,
  screeningClassifierId,
  setBackgroundClassifier,
  setScreeningClassifier,
  testClassifierProfile,
} from '../services/classifiers/classifier-service.ts'
import { recordClassifierResultUsage } from '../services/classifiers/classifier-usage.ts'
import { localClassifiers } from '../services/classifiers/local-classifiers.ts'

export function registerClassifierHandlers(win: BrowserWindow): void {
  ipcMain.handle('classifiers:list', (event) => {
    assertMainFrameSender(event, win)
    return listClassifierProfiles()
  })
  ipcMain.handle('classifiers:save', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return saveClassifierProfile(parseIpcArgs(classifierProfileSchema, [raw]))
  })
  ipcMain.handle('classifiers:remove', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return removeClassifierProfile(parseIpcArgs(keyProviderSchema.max(53), [raw]))
  })
  ipcMain.handle('classifiers:test', async (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(keyProviderSchema.max(53), [raw])
    const result = await testClassifierProfile(id)
    // The sample is a real call: tokens a provider reports for it count like any other.
    recordClassifierResultUsage(getClassifierProfile(id).label, result)
    return result
  })
  ipcMain.handle('classifiers:screening', (event) => {
    assertMainFrameSender(event, win)
    return screeningClassifierId()
  })
  ipcMain.handle('classifiers:set-screening', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return setScreeningClassifier(parseIpcArgs(keyProviderSchema.max(53).nullable(), [raw]))
  })
  ipcMain.handle('classifiers:background', (event) => {
    assertMainFrameSender(event, win)
    return backgroundClassifierId()
  })
  ipcMain.handle('classifiers:set-background', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return setBackgroundClassifier(parseIpcArgs(keyProviderSchema.max(53).nullable(), [raw]))
  })

  ipcMain.handle('local-classifiers:status', (event) => {
    assertMainFrameSender(event, win)
    return localClassifiers().overview()
  })
  ipcMain.handle('local-classifiers:install', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return localClassifiers().install(parseIpcArgs(keyProviderSchema.max(53), [raw]))
  })
  ipcMain.handle('local-classifiers:start', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return localClassifiers().start(parseIpcArgs(keyProviderSchema.max(53), [raw]))
  })
  ipcMain.handle('local-classifiers:stop', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return localClassifiers().stop(parseIpcArgs(keyProviderSchema.max(53), [raw]))
  })
  ipcMain.handle('local-classifiers:uninstall', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return localClassifiers().uninstall(parseIpcArgs(keyProviderSchema.max(53), [raw]))
  })
  ipcMain.handle('local-classifiers:connect', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return localClassifiers().connect(parseIpcArgs(keyProviderSchema.max(53), [raw]))
  })
}
