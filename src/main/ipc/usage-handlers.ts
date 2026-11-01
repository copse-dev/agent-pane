import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import { defineArgumentListHandler, defineHandler } from './define-handler.ts'
import { zProjectId, zThreadId } from './ipc-guards.ts'
import { getThreadClassifierUse } from '../services/security/classifier-use-report.ts'
import { getUsageSummary } from '../services/storage/usage-ledger.ts'
import { signInToClaude } from '../services/claude-sign-in.ts'
import {
  getPlanWorthItPayload,
  loadPlanUsageSnapshotAndSample,
  setClaudePlanMonthlyFeeUsd,
} from '../services/storage/plan-window-history.ts'

export function registerUsageHandlers(win: BrowserWindow): void {
  defineHandler(win, 'usage:sign-in-to-claude', z.tuple([]), () => signInToClaude())
  defineHandler(win, 'usage:get-summary', z.tuple([]), () => getUsageSummary(), { sender: 'any' })
  // What the classifiers (shell guard, tier screen, terminal-read screen) did for one
  // thread: calls, verdicts, latency and tokens, from the thread's decision log.
  defineArgumentListHandler(
    win,
    'usage:get-thread-classifier-use',
    z.tuple([zProjectId, zThreadId]),
    ([projectId, threadId]) => getThreadClassifierUse(projectId, threadId),
  )
  defineHandler(
    win,
    'usage:get-plan-usage',
    z.tuple([z.boolean().optional()]),
    async (refresh) => loadPlanUsageSnapshotAndSample({ force: refresh === true }),
    { sender: 'any' },
  )
  defineHandler(win, 'usage:get-plan-worth-it', z.tuple([]), () => getPlanWorthItPayload(), {
    sender: 'any',
  })
  // The fee keeps its hand-written check and error message.
  defineHandler(win, 'usage:set-claude-plan-monthly-fee', z.tuple([z.unknown()]), async (fee) => {
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
