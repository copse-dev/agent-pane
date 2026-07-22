import { storageGet, storageSet } from './storage.ts'
import { getSetting, setSetting } from './settings.ts'
import { loadPlanUsageSnapshot } from '../plan-usage-bridge.ts'
import type { PlanUsageSnapshot } from '@copse/plan-usage'
import {
  PLAN_WINDOW_HISTORY_STORAGE_KEY,
  appendPlanWindowSamples,
  parsePlanWindowHistory,
  samplesFromSnapshot,
  windowExhaustionRates,
  type PlanWindowHistoryState,
} from '@shared/usage/plan-window-history.ts'
import {
  computePlanWorthIt,
  latestClaudeSample,
  type PlanWorthItPayload,
} from '@shared/usage/plan-worth-it.ts'

export type { PlanWorthItPayload }

export const CLAUDE_PLAN_MONTHLY_FEE_SETTING = 'claudePlanMonthlyFeeUsd'

function readHistory(): PlanWindowHistoryState {
  return parsePlanWindowHistory(storageGet(PLAN_WINDOW_HISTORY_STORAGE_KEY))
}

function writeHistory(state: PlanWindowHistoryState): void {
  storageSet(PLAN_WINDOW_HISTORY_STORAGE_KEY, state)
}

/** Sample the snapshot into history (rate-limited / reset-aware). */
export function recordPlanUsageSample(snapshot: PlanUsageSnapshot, now = Date.now()): void {
  const incoming = samplesFromSnapshot(snapshot, now)
  if (incoming.length === 0) return
  writeHistory(appendPlanWindowSamples(readHistory(), incoming, now))
}

/**
 * Fetch live plan usage, append a history sample, and return the snapshot.
 * Failures still resolve (bridge never throws); sampling is best-effort.
 */
export async function loadPlanUsageSnapshotAndSample(): Promise<PlanUsageSnapshot> {
  const snapshot = await loadPlanUsageSnapshot()
  try {
    recordPlanUsageSample(snapshot)
  } catch {
    /* history must never block Settings → Usage */
  }
  return snapshot
}

function readMonthlyFeeUsd(): number | null {
  const raw = getSetting<number | null>(CLAUDE_PLAN_MONTHLY_FEE_SETTING, null)
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw
  return null
}

export function getPlanWorthItPayload(): PlanWorthItPayload {
  const history = readHistory()
  const worthIt = computePlanWorthIt({
    completed: history.completed,
    latestClaudeSample: latestClaudeSample(history.samples),
    monthlyFeeUsd: readMonthlyFeeUsd(),
  })
  const rates = windowExhaustionRates(history.completed, 'claude')
  return {
    worthIt,
    windowExhaustion: [...rates.entries()].map(([windowId, { hit, total }]) => ({
      windowId,
      hit,
      total,
    })),
    historySampleCount: history.samples.filter((s) => s.provider === 'claude').length,
    completedWeeklyCount: worthIt.completedWeeklyCount,
  }
}

export async function setClaudePlanMonthlyFeeUsd(fee: number | null): Promise<void> {
  if (fee === null || !Number.isFinite(fee) || fee <= 0) {
    await setSetting(CLAUDE_PLAN_MONTHLY_FEE_SETTING, null)
    return
  }
  await setSetting(CLAUDE_PLAN_MONTHLY_FEE_SETTING, fee)
}
