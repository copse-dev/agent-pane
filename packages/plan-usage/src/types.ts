/** Shared types for subscription plan-usage windows (Claude / Codex / HF / Cursor). */

export type PlanProviderId = 'claude' | 'codex' | 'huggingface' | 'cursor'

/** One rolling (or fixed) usage window reported by a provider. */
export interface PlanWindow {
  /** Stable id for the window (`five_hour`, `seven_day`, `primary`, …). */
  id: string
  /** Human label for UI (`5-hour`, `Weekly`, …). */
  label: string
  /** Percent of the window already consumed, clamped to `[0, 100]`. */
  usedPercent: number
  /** ISO-8601 reset time when known; `null` when the provider omits it. */
  resetsAt: string | null
  /**
   * Provider urgency hint when present (`normal` / `warning` / `critical` from
   * Claude `limits[].severity`). Omitted when the provider does not report it.
   */
  severity?: string | null
  /**
   * API-equivalent dollars already consumed in this window, when the provider
   * reports them (Claude legacy `used_dollars`). Powers plan-worth-it math;
   * the UI progress bar still uses {@link usedPercent}.
   */
  usedDollars?: number
  /**
   * API-equivalent dollar cap for this window, when the provider reports it
   * (Claude legacy `limit_dollars`).
   */
  limitDollars?: number
}

export interface ProviderPlanUsage {
  provider: PlanProviderId
  /** Plan name when the provider reports one (`Max 5x`, `plus`, …). */
  plan: string | null
  windows: PlanWindow[]
  checkedAt: string
}

export type ProviderPlanResult =
  | { status: 'ok'; provider: PlanProviderId; usage: ProviderPlanUsage }
  | { status: 'unavailable'; provider: PlanProviderId; reason: string }
  | { status: 'error'; provider: PlanProviderId; message: string }

export interface PlanUsageSnapshot {
  providers: ProviderPlanResult[]
  checkedAt: string
  /** Fatal snapshot-level failure before provider-specific checks could finish. */
  error?: string
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

export interface PlanUsageFetchOptions {
  fetch?: FetchLike
  /** Abort / timeout signal; host supplies `AbortSignal.timeout(ms)`. */
  signal?: AbortSignal
  /** Override `Date.now()` for tests. */
  now?: () => number
}
