// Pure helpers for the account-wide plan-window history ledger.
// Samples come from live `PlanUsageSnapshot` fetches (Claude first); completed
// windows are finalized when a later sample shows the same window id with a
// newer resetsAt and lower usedPercent.

import type { PlanProviderId, PlanUsageSnapshot, PlanWindow } from '@copse/plan-usage'

export const PLAN_WINDOW_HISTORY_STORAGE_KEY = 'planWindowHistory'
export const PLAN_WINDOW_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
/** Minimum gap between ordinary samples of the same provider (unless a reset). */
export const PLAN_WINDOW_SAMPLE_MIN_GAP_MS = 15 * 60 * 1000

export interface PlanWindowSampleWindow {
  id: string
  label: string
  usedPercent: number
  resetsAt: string | null
  usedDollars?: number
  limitDollars?: number
}

export interface PlanWindowHistorySample {
  at: number
  provider: PlanProviderId
  planLabel: string | null
  windows: PlanWindowSampleWindow[]
}

/** One finished plan window (prior peak at the moment a reset was observed). */
export interface CompletedPlanWindow {
  provider: PlanProviderId
  windowId: string
  label: string
  /** Peak used-percent observed before the reset. */
  usedPercent: number
  usedDollars?: number
  limitDollars?: number
  /** resetsAt of the window that just ended (prior sample). */
  endedResetsAt: string | null
  /** Sample time when the reset was detected. */
  completedAt: number
}

export interface PlanWindowHistoryState {
  samples: PlanWindowHistorySample[]
  completed: CompletedPlanWindow[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSampleWindow(raw: unknown): PlanWindowSampleWindow | null {
  if (!isRecord(raw)) return null
  if (typeof raw['id'] !== 'string' || !raw['id']) return null
  if (typeof raw['label'] !== 'string') return null
  if (typeof raw['usedPercent'] !== 'number' || !Number.isFinite(raw['usedPercent'])) return null
  const resetsAt =
    raw['resetsAt'] === null ? null : typeof raw['resetsAt'] === 'string' ? raw['resetsAt'] : null
  const out: PlanWindowSampleWindow = {
    id: raw['id'],
    label: raw['label'],
    usedPercent: raw['usedPercent'],
    resetsAt,
  }
  if (typeof raw['usedDollars'] === 'number' && Number.isFinite(raw['usedDollars'])) {
    out.usedDollars = raw['usedDollars']
  }
  if (typeof raw['limitDollars'] === 'number' && Number.isFinite(raw['limitDollars'])) {
    out.limitDollars = raw['limitDollars']
  }
  return out
}

function parseSample(raw: unknown): PlanWindowHistorySample | null {
  if (!isRecord(raw)) return null
  if (typeof raw['at'] !== 'number' || !Number.isFinite(raw['at'])) return null
  const provider = raw['provider']
  if (
    provider !== 'claude' &&
    provider !== 'codex' &&
    provider !== 'huggingface' &&
    provider !== 'cursor'
  ) {
    return null
  }
  if (!Array.isArray(raw['windows'])) return null
  const windows: PlanWindowSampleWindow[] = []
  for (const w of raw['windows']) {
    const parsed = parseSampleWindow(w)
    if (parsed) windows.push(parsed)
  }
  if (windows.length === 0) return null
  const planLabel =
    raw['planLabel'] === null
      ? null
      : typeof raw['planLabel'] === 'string'
        ? raw['planLabel']
        : null
  return { at: raw['at'], provider, planLabel, windows }
}

function parseCompleted(raw: unknown): CompletedPlanWindow | null {
  if (!isRecord(raw)) return null
  if (
    raw['provider'] !== 'claude' &&
    raw['provider'] !== 'codex' &&
    raw['provider'] !== 'huggingface' &&
    raw['provider'] !== 'cursor'
  ) {
    return null
  }
  if (typeof raw['windowId'] !== 'string' || !raw['windowId']) return null
  if (typeof raw['label'] !== 'string') return null
  if (typeof raw['usedPercent'] !== 'number' || !Number.isFinite(raw['usedPercent'])) return null
  if (typeof raw['completedAt'] !== 'number' || !Number.isFinite(raw['completedAt'])) return null
  const endedResetsAt =
    raw['endedResetsAt'] === null
      ? null
      : typeof raw['endedResetsAt'] === 'string'
        ? raw['endedResetsAt']
        : null
  const out: CompletedPlanWindow = {
    provider: raw['provider'],
    windowId: raw['windowId'],
    label: raw['label'],
    usedPercent: raw['usedPercent'],
    endedResetsAt,
    completedAt: raw['completedAt'],
  }
  if (typeof raw['usedDollars'] === 'number' && Number.isFinite(raw['usedDollars'])) {
    out.usedDollars = raw['usedDollars']
  }
  if (typeof raw['limitDollars'] === 'number' && Number.isFinite(raw['limitDollars'])) {
    out.limitDollars = raw['limitDollars']
  }
  return out
}

/** Parse persisted history JSON; drops malformed entries. */
export function parsePlanWindowHistory(raw: unknown): PlanWindowHistoryState {
  if (!isRecord(raw)) return { samples: [], completed: [] }
  const samples: PlanWindowHistorySample[] = []
  if (Array.isArray(raw['samples'])) {
    for (const item of raw['samples']) {
      const parsed = parseSample(item)
      if (parsed) samples.push(parsed)
    }
  }
  const completed: CompletedPlanWindow[] = []
  if (Array.isArray(raw['completed'])) {
    for (const item of raw['completed']) {
      const parsed = parseCompleted(item)
      if (parsed) completed.push(parsed)
    }
  }
  return { samples, completed }
}

export function prunePlanWindowHistory(
  state: PlanWindowHistoryState,
  now = Date.now(),
): PlanWindowHistoryState {
  const cutoff = now - PLAN_WINDOW_HISTORY_RETENTION_MS
  return {
    samples: state.samples.filter((s) => s.at >= cutoff),
    completed: state.completed.filter((c) => c.completedAt >= cutoff),
  }
}

function toSampleWindow(w: PlanWindow): PlanWindowSampleWindow {
  return {
    id: w.id,
    label: w.label,
    usedPercent: w.usedPercent,
    resetsAt: w.resetsAt,
    ...(w.usedDollars !== undefined ? { usedDollars: w.usedDollars } : {}),
    ...(w.limitDollars !== undefined ? { limitDollars: w.limitDollars } : {}),
  }
}

/** Build history samples from a live snapshot (ok providers only). */
export function samplesFromSnapshot(
  snapshot: PlanUsageSnapshot,
  at = Date.now(),
): PlanWindowHistorySample[] {
  const out: PlanWindowHistorySample[] = []
  for (const result of snapshot.providers) {
    if (result.status !== 'ok') continue
    if (result.usage.windows.length === 0) continue
    out.push({
      at,
      provider: result.provider,
      planLabel: result.usage.plan,
      windows: result.usage.windows.map(toSampleWindow),
    })
  }
  return out
}

function resetsAdvanced(prev: string | null, next: string | null): boolean {
  if (!prev || !next) return false
  const prevMs = Date.parse(prev)
  const nextMs = Date.parse(next)
  if (!Number.isFinite(prevMs) || !Number.isFinite(nextMs)) return prev !== next
  return nextMs > prevMs
}

/**
 * True when this sample should be kept even if the min gap has not elapsed —
 * a window reset (newer resetsAt + lower used%) for any tracked window.
 */
export function sampleShowsReset(
  previous: PlanWindowHistorySample | undefined,
  next: PlanWindowHistorySample,
): boolean {
  if (!previous || previous.provider !== next.provider) return false
  const prevById = new Map(previous.windows.map((w) => [w.id, w]))
  for (const w of next.windows) {
    const prev = prevById.get(w.id)
    if (!prev) continue
    if (resetsAdvanced(prev.resetsAt, w.resetsAt) && w.usedPercent < prev.usedPercent) {
      return true
    }
  }
  return false
}

/** Finalize completed windows by comparing the prior sample to the new one. */
export function detectCompletedWindows(
  previous: PlanWindowHistorySample | undefined,
  next: PlanWindowHistorySample,
): CompletedPlanWindow[] {
  if (!previous || previous.provider !== next.provider) return []
  const nextById = new Map(next.windows.map((w) => [w.id, w]))
  const out: CompletedPlanWindow[] = []
  for (const prev of previous.windows) {
    const cur = nextById.get(prev.id)
    if (!cur) continue
    if (!resetsAdvanced(prev.resetsAt, cur.resetsAt)) continue
    if (!(cur.usedPercent < prev.usedPercent)) continue
    const completed: CompletedPlanWindow = {
      provider: next.provider,
      windowId: prev.id,
      label: prev.label,
      usedPercent: prev.usedPercent,
      endedResetsAt: prev.resetsAt,
      completedAt: next.at,
    }
    if (prev.usedDollars !== undefined) completed.usedDollars = prev.usedDollars
    if (prev.limitDollars !== undefined) completed.limitDollars = prev.limitDollars
    out.push(completed)
  }
  return out
}

/**
 * When a sample is dropped by the min-gap rate limit, fold any higher
 * usedPercent / usedDollars into a new retained prior sample for the same
 * window id + resetsAt. Otherwise a later reset finalizes an under-count.
 * Returns `retained` unchanged when providers differ.
 */
export function foldSkippedSamplePeaks(
  retained: PlanWindowHistorySample,
  skipped: PlanWindowHistorySample,
): PlanWindowHistorySample {
  if (retained.provider !== skipped.provider) return retained
  const windows = retained.windows.map((w) => ({ ...w }))
  const byId = new Map(windows.map((w, i) => [w.id, i]))
  for (const incoming of skipped.windows) {
    const idx = byId.get(incoming.id)
    if (idx === undefined) {
      windows.push({ ...incoming })
      byId.set(incoming.id, windows.length - 1)
      continue
    }
    const prev = windows[idx]
    if (!prev || prev.resetsAt !== incoming.resetsAt) continue
    if (incoming.usedPercent > prev.usedPercent) {
      prev.usedPercent = incoming.usedPercent
    }
    if (
      typeof incoming.usedDollars === 'number' &&
      (typeof prev.usedDollars !== 'number' || incoming.usedDollars > prev.usedDollars)
    ) {
      prev.usedDollars = incoming.usedDollars
    }
    if (typeof incoming.limitDollars === 'number' && Number.isFinite(incoming.limitDollars)) {
      prev.limitDollars = incoming.limitDollars
    }
  }
  return { ...retained, windows }
}

/**
 * Merge new samples into history. Rate-limits ordinary samples per provider;
 * always keeps a sample that shows a reset and records completed windows.
 * Gap-skipped samples still contribute peak used%/$ into the retained prior.
 */
export function appendPlanWindowSamples(
  state: PlanWindowHistoryState,
  incoming: readonly PlanWindowHistorySample[],
  now = Date.now(),
): PlanWindowHistoryState {
  const samples = [...state.samples]
  let completed = [...state.completed]
  for (const sample of incoming) {
    // Reverse scan (not Array#findLastIndex) — tsconfig lib is ES2022.
    let priorIndex = -1
    for (let i = samples.length - 1; i >= 0; i--) {
      if (samples[i]?.provider === sample.provider) {
        priorIndex = i
        break
      }
    }
    const priorForProvider = priorIndex >= 0 ? samples[priorIndex] : undefined
    const isReset = sampleShowsReset(priorForProvider, sample)
    if (
      priorForProvider &&
      priorIndex >= 0 &&
      !isReset &&
      sample.at - priorForProvider.at < PLAN_WINDOW_SAMPLE_MIN_GAP_MS
    ) {
      samples[priorIndex] = foldSkippedSamplePeaks(priorForProvider, sample)
      continue
    }
    const newlyCompleted = detectCompletedWindows(priorForProvider, sample)
    if (newlyCompleted.length > 0) completed = [...completed, ...newlyCompleted]
    samples.push(sample)
  }
  return prunePlanWindowHistory({ samples, completed }, now)
}

/** Peak usedDollars (or percent×limit) for a completed window. */
export function completedWindowApiDollars(window: CompletedPlanWindow): number | null {
  if (typeof window.usedDollars === 'number' && Number.isFinite(window.usedDollars)) {
    return window.usedDollars
  }
  if (
    typeof window.limitDollars === 'number' &&
    Number.isFinite(window.limitDollars) &&
    window.limitDollars > 0
  ) {
    return (window.usedPercent / 100) * window.limitDollars
  }
  return null
}

/**
 * Exhaustion rate per window id for a provider: fraction of completed windows
 * that ended at ≥100% used. Used by the value map "Expected plan" cost basis.
 */
export function windowExhaustionRates(
  completed: readonly CompletedPlanWindow[],
  provider: PlanProviderId = 'claude',
): Map<string, { hit: number; total: number }> {
  const map = new Map<string, { hit: number; total: number }>()
  for (const c of completed) {
    if (c.provider !== provider) continue
    const cur = map.get(c.windowId) ?? { hit: 0, total: 0 }
    cur.total += 1
    if (c.usedPercent >= 100) cur.hit += 1
    map.set(c.windowId, cur)
  }
  return map
}
