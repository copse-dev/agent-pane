import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs } from './ipc-guards.ts'
import {
  applyEnvironmentSetup,
  dismissEnvironmentSetup,
  environmentSetupStatus,
  reviewEnvironmentSetup,
  undoEnvironmentSetup,
} from '../services/security/environment-setup.ts'

export function registerEnvironmentSetupHandlers(win: BrowserWindow): void {
  // Environment setup: the renderer sends only which issued suggestion ids were
  // ticked; main applies the values it computed (docs/plans/environment-setup.md).
  ipcMain.handle('environment-setup:status', (event) => {
    assertMainFrameSender(event, win)
    return environmentSetupStatus()
  })
  ipcMain.handle('environment-setup:review', (event) => {
    assertMainFrameSender(event, win)
    return reviewEnvironmentSetup()
  })
  ipcMain.handle('environment-setup:apply', (event, rawReview: unknown, rawIds: unknown) => {
    assertMainFrameSender(event, win)
    const [reviewId, ids] = parseIpcArgs(z.tuple([z.uuid(), z.array(z.uuid()).max(64)]), [
      rawReview,
      rawIds,
    ])
    return applyEnvironmentSetup(reviewId, ids)
  })
  ipcMain.handle('environment-setup:undo', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return undoEnvironmentSetup(parseIpcArgs(z.uuid(), [raw]))
  })
  ipcMain.handle('environment-setup:dismiss', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return dismissEnvironmentSetup(parseIpcArgs(z.boolean(), [raw]))
  })
}
