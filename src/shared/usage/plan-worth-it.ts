// Pure "is your plan worth it?" verdict: compare account-wide weekly
// API-equivalent burn (from completed plan windows) against the subscription
// fee amortized per week. Does not use the Copse-local token ledger.

import {
  completedWindowApiDollars,
  type CompletedPlanWindow,
  type PlanWindowHistorySample,
} from './plan-window-history.ts'

export type PlanWorthItVerdictKind =
  'worth_it' | 'borderline' | 'not_worth_it' | 'insufficient_history' | 'needs_fee'

/** Minimum completed weekly windows before a hard burn-vs-fee verdict. */
export const PLAN_WORTH_IT_MIN_WEEKLY_SAMPLES = 2
/** Burn ≥ this × fee/week → worth_it. */
export const PLAN_WORTH_IT_THRESHOLD = 0.85
/** Burn < this × fee/week → not_worth_it. */
export const PLAN_NOT_WORTH_IT_THRESHOLD = 0.5

export interface PlanFeeHint {
  monthlyFeeUsd: number
  /** Short label for the inferred tier (`Pro`, `Max 5x`, …). */
  label: string
}

export interface PlanWorthItInput {
  completed: readonly CompletedPlanWindow[]
  /** Latest Claude sample (for live limitDollars fee hint). */
  latestClaudeSample?: PlanWindowHistorySample | null
  /** User-entered or previously saved monthly fee; null/undefined = unset. */
  monthlyFeeUsd?: number | null
  /**
   * Optional counterfactual note from the caller (e.g. value-map Inference
   * frontier tip). Passed through onto the result when present.
   */
  inferenceFrontierNote?: string | null
}

export interface PlanWorthItResult {
  verdict: PlanWorthItVerdictKind
  reason: string
  /** Mean API-equivalent $ burn over completed weekly windows; null if none. */
  apiEquivalentBurnPerWeek: number | null
  /** Monthly fee / ~4.348 weeks when a fee is known. */
  planFeePerWeek: number | null
  monthlyFeeUsd: number | null
  feeHint: PlanFeeHint | null
  completedWeeklyCount: number
  inferenceFrontierNote: string | null
}

/** IPC payload for Settings → Usage plan worth-it card + Expected map mode. */
export interface PlanWorthItPayload {
  worthIt: PlanWorthItResult
  /** Exhaustion rates for Claude windows (for the Expected plan map mode). */
  windowExhaustion: Array<{ windowId: string; hit: number; total: number }>
  historySampleCount: number
  completedWeeklyCount: number
}

const WEEKS_PER_MONTH = 365.25 / 7 / 12

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0'
  const rounded = Math.round(n * 100) / 100
  if (Number.isInteger(rounded)) return `$${String(rounded)}`
  return `$${rounded.toFixed(2)}`
}

/**
 * Infer a monthly plan fee from Claude weekly `limitDollars` tiers.
 * Returns null when the limit does not match a known band.
 */
export function hintMonthlyFeeFromWeeklyLimit(
  limitDollars: number | null | undefined,
): PlanFeeHint | null {
  if (typeof limitDollars !== 'number' || !Number.isFinite(limitDollars) || limitDollars <= 0) {
    return null
  }
  // Anthropic's internal dollar caps roughly track Pro / Max 5x / Max 20x.
  if (limitDollars >= 15 && limitDollars <= 40) {
    return { monthlyFeeUsd: 20, label: 'Pro' }
  }
  if (limitDollars >= 70 && limitDollars <= 140) {
    return { monthlyFeeUsd: 100, label: 'Max 5x' }
  }
  if (limitDollars >= 160 && limitDollars <= 280) {
    return { monthlyFeeUsd: 200, label: 'Max 20x' }
  }
  return null
}

/** Weekly `seven_day` limitDollars from the latest sample or completed windows. */
export function resolveWeeklyLimitDollars(
  latestClaudeSample: PlanWindowHistorySample | null | undefined,
  completed: readonly CompletedPlanWindow[],
): number | null {
  const fromSample = latestClaudeSample?.windows.find((w) => w.id === 'seven_day')?.limitDollars
  if (typeof fromSample === 'number' && Number.isFinite(fromSample) && fromSample > 0) {
    return fromSample
  }
  for (let i = completed.length - 1; i >= 0; i--) {
    const c = completed[i]
    if (!c || c.provider !== 'claude' || c.windowId !== 'seven_day') continue
    if (typeof c.limitDollars === 'number' && c.limitDollars > 0) return c.limitDollars
  }
  return null
}

export function monthlyFeeToWeekly(monthlyFeeUsd: number): number {
  return monthlyFeeUsd / WEEKS_PER_MONTH
}

function meanWeeklyBurn(completed: readonly CompletedPlanWindow[]): {
  mean: number | null
  count: number
} {
  const weekly = completed.filter((c) => c.provider === 'claude' && c.windowId === 'seven_day')
  const dollars: number[] = []
  for (const w of weekly) {
    const d = completedWindowApiDollars(w)
    if (d !== null) dollars.push(d)
  }
  if (dollars.length === 0) return { mean: null, count: weekly.length }
  const sum = dollars.reduce((a, b) => a + b, 0)
  return { mean: sum / dollars.length, count: dollars.length }
}

/**
 * Compute the Claude plan worth-it verdict. Pure — no I/O.
 */
export function computePlanWorthIt(input: PlanWorthItInput): PlanWorthItResult {
  const { mean, count } = meanWeeklyBurn(input.completed)
  const weeklyLimit = resolveWeeklyLimitDollars(input.latestClaudeSample, input.completed)
  const feeHint = hintMonthlyFeeFromWeeklyLimit(weeklyLimit)
  const feeFromUser =
    typeof input.monthlyFeeUsd === 'number' &&
    Number.isFinite(input.monthlyFeeUsd) &&
    input.monthlyFeeUsd > 0
      ? input.monthlyFeeUsd
      : null
  const monthlyFeeUsd = feeFromUser ?? feeHint?.monthlyFeeUsd ?? null
  const planFeePerWeek = monthlyFeeUsd !== null ? monthlyFeeToWeekly(monthlyFeeUsd) : null
  const inferenceFrontierNote = input.inferenceFrontierNote?.trim() || null

  const base = {
    apiEquivalentBurnPerWeek: mean,
    planFeePerWeek,
    monthlyFeeUsd,
    feeHint,
    completedWeeklyCount: count,
    inferenceFrontierNote,
  }

  if (count < PLAN_WORTH_IT_MIN_WEEKLY_SAMPLES || mean === null) {
    return {
      ...base,
      verdict: 'insufficient_history',
      reason:
        'Need a couple of completed weekly windows — keep Copse signed into Claude and reopen Usage after resets.',
    }
  }

  if (monthlyFeeUsd === null || planFeePerWeek === null) {
    return {
      ...base,
      verdict: 'needs_fee',
      reason:
        'Enter your Claude plan’s monthly fee to compare API-equivalent burn against the subscription.',
    }
  }

  const ratio = mean / planFeePerWeek
  if (ratio >= PLAN_WORTH_IT_THRESHOLD) {
    return {
      ...base,
      verdict: 'worth_it',
      reason: `Last ${String(count)} weekly windows averaged ${formatUsd(mean)} of API-equivalent burn; at ${formatUsd(monthlyFeeUsd)}/mo (~${formatUsd(planFeePerWeek)}/wk) the plan is ahead of paying inference rates.`,
    }
  }
  if (ratio < PLAN_NOT_WORTH_IT_THRESHOLD) {
    return {
      ...base,
      verdict: 'not_worth_it',
      reason: `Last ${String(count)} weekly windows averaged ${formatUsd(mean)} of API-equivalent burn; at ${formatUsd(monthlyFeeUsd)}/mo (~${formatUsd(planFeePerWeek)}/wk) paying inference rates would likely be cheaper.`,
    }
  }
  return {
    ...base,
    verdict: 'borderline',
    reason: `Last ${String(count)} weekly windows averaged ${formatUsd(mean)} of API-equivalent burn; at ${formatUsd(monthlyFeeUsd)}/mo (~${formatUsd(planFeePerWeek)}/wk) the plan is close to break-even vs inference pricing.`,
  }
}

/** Latest Claude sample from a history sample list (by `at`). */
export function latestClaudeSample(
  samples: readonly PlanWindowHistorySample[],
): PlanWindowHistorySample | null {
  let best: PlanWindowHistorySample | null = null
  for (const s of samples) {
    if (s.provider !== 'claude') continue
    if (!best || s.at > best.at) best = s
  }
  return best
}

