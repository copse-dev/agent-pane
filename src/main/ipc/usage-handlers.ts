import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import { defineArgumentListHandler, defineHandler } from './define-handler.ts'
import { zProjectId, zThreadId } from './ipc-guards.ts'
import { getThreadClassifierUse } from '../services/security/classifier-use-report.ts'
import { getUsageSummary } from '../services/storage/usage-ledger.ts'
import { loadPlanUsageSnapshot } from '../services/plan-usage-bridge.ts'

export function registerUsageHandlers(win: BrowserWindow): void {
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
    async (refresh) => loadPlanUsageSnapshot({ force: refresh === true }),
    { sender: 'any' },
  )
}
