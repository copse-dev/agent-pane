import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs, zProjectId, zThreadId } from './ipc-guards.ts'
import { getThreadClassifierUse } from '../services/security/classifier-use-report.ts'
import { getUsageSummary } from '../services/storage/usage-ledger.ts'
import {
  getPlanWorthItPayload,
  loadPlanUsageSnapshotAndSample,
  setClaudePlanMonthlyFeeUsd,
} from '../services/storage/plan-window-history.ts'

export function registerUsageHandlers(win: BrowserWindow): void {
  ipcMain.handle('usage:get-summary', () => getUsageSummary())
  // What the classifiers (shell guard, tier screen, terminal-read screen) did for one
  // thread: calls, verdicts, latency and tokens, from the thread's decision log.
  ipcMain.handle('usage:get-thread-classifier-use', (event, ...rawArgs: unknown[]) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), rawArgs)
    return getThreadClassifierUse(projectId, threadId)
  })
  ipcMain.handle('usage:get-plan-usage', async (_event, force: unknown) => {
    const refresh = parseIpcArgs(z.boolean().optional(), [force])
    return loadPlanUsageSnapshotAndSample({ force: refresh === true })
  })
  ipcMain.handle('usage:get-plan-worth-it', () => getPlanWorthItPayload())
  ipcMain.handle('usage:set-claude-plan-monthly-fee', async (event, fee: unknown) => {
    assertMainFrameSender(event, win)
    if (fee === null || fee === undefined || fee === '') {
      await setClaudePlanMonthlyFeeUsd(null)
      return getPlanWorthItPayload()
    }
    if (typeof fee !== 'number' || !Number.isFinite(fee)) {
      throw new Error('Claude plan monthly fee must be a positive number or null')
    }
    await setClaudePlanMonthlyFeeUsd(fee)
    return getPlanWorthItPayload()
  })
}
