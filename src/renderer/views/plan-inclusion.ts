// Plan-inclusion resolver: given the live subscription usage snapshot
// (`api.usage.getPlanUsage()`), decide whether a model reached through a
// PLAN-BILLED access path (an ACP CLI login, or Cursor's included pool) is
// currently covered — and, when its governing window is spent, that the plan
// limit is reached rather than silently free.
//
// This is deliberately pure and access-path agnostic: callers decide which
// rows are plan-billed (see the billing map in the picker / map wiring) and
// pass the provider + model here. Only KEY-billed paths (direct API keys,
// Cloud Agents that authenticate with an API key) must never be routed through
// this — their cost is the real per-token price, never "included".
//
// The binding window is the TIGHTEST constraint: a model's usage counts against
// every window that governs it (a 5-hour rate limit, the weekly all-models
// pool, and any per-model weekly sub-cap), so the one with the highest
// used-percent is what actually gates it — and if that one is spent, the model
// is over its plan limit even if a looser window still has room. This is
// exactly the Fable case: `seven_day_fable` can hit 100% while `seven_day`
// (all models) still has headroom.

import type { PlanProviderId, PlanUsageSnapshot, PlanWindow } from '@copse/plan-usage'
import type { FrontierCandidate } from '@copse/llm/pareto-frontier.ts'
import { resolveIntellectModelId } from '@copse/llm/model-intellect.ts'

export interface PlanInclusion {
  provider: PlanProviderId
  /** The binding (tightest) window's human label, e.g. "Weekly Fable". */
  windowLabel: string
  /** Percent of that window consumed, 0–100. */
  usedPercent: number
  /** ISO-8601 reset time of the binding window, when the provider reports it. */
  resetsAt: string | null
  /** usedPercent ≥ 100 — the plan no longer covers new usage here. */
  exhausted: boolean
}

/** Lower-cased model family Claude's per-model weekly windows are keyed by. */
function claudeModelFamily(modelId: string): string | null {
  const id = modelId.toLowerCase()
  if (id.includes('fable')) return 'fable'
  if (id.includes('opus')) return 'opus'
  if (id.includes('sonnet')) return 'sonnet'
  if (id.includes('haiku')) return 'haiku'
  return null
}

/**
 * Window ids that govern a Claude model, in the order a display should prefer
 * when several are absent — the per-model weekly cap first, then the weekly
 * all-models pool, then the 5-hour rate window. All present ones apply; the
 * tightest binds.
 */
export function claudeGoverningWindowIds(modelId: string): string[] {
  const family = claudeModelFamily(modelId)
  const ids: string[] = []
  if (family) ids.push(`seven_day_${family}`)
  ids.push('seven_day', 'five_hour')
  return ids
}

/** Window ids (in preference order) that govern a model for a given provider. */
function governingWindowIds(provider: PlanProviderId, modelId: string | undefined): string[] {
  switch (provider) {
    case 'claude':
      return modelId ? claudeGoverningWindowIds(modelId) : ['seven_day', 'five_hour']
    case 'cursor':
      // Cursor's included subscription pool. `total` is the overall included
      // allowance; `auto` is the first-party sub-pool. Both gate coverage when
      // present; the tightest binds.
      return ['total', 'auto']
    case 'codex':
      return ['primary', 'secondary']
    case 'huggingface':
      return ['inference_providers']
  }
}

function providerWindows(
  snapshot: PlanUsageSnapshot,
  provider: PlanProviderId,
): PlanWindow[] | null {
  const result = snapshot.providers.find((r) => r.provider === provider)
  return result && result.status === 'ok' ? result.usage.windows : null
}

/**
 * Resolve a model's plan coverage on a given provider's subscription from the
 * live snapshot. Returns null when that provider isn't on a plan we can read,
 * or when no window governs the model — a null means "no plan claim", never
 * "free". A non-null result with `exhausted: true` means the plan limit is
 * reached (show that, don't imply it's still included).
 */
export function resolvePlanInclusion(
  provider: PlanProviderId,
  modelId: string | undefined,
  snapshot: PlanUsageSnapshot,
): PlanInclusion | null {
  const windows = providerWindows(snapshot, provider)
  if (!windows || windows.length === 0) return null
  const govern = new Set(governingWindowIds(provider, modelId))
  const applicable = windows.filter((w) => govern.has(w.id))
  if (applicable.length === 0) return null
  // The tightest window (highest used-percent) is the real constraint.
  const binding = applicable.reduce((tightest, w) =>
    w.usedPercent > tightest.usedPercent ? w : tightest,
  )
  return {
    provider,
    windowLabel: binding.label,
    usedPercent: binding.usedPercent,
    resetsAt: binding.resetsAt,
    exhausted: binding.usedPercent >= 100,
  }
}

/**
 * Which subscription plan (if any) can bill a model, keyed off the model's
 * identity. Conservative on purpose — only the paths the user confirmed run on a
 * plan: Claude models on the Claude plan, and Grok on the Cursor plan (Cursor
 * includes it). The mapping only ever *activates* when the snapshot actually
 * carries that provider's windows, so an unused mapping is harmless.
 */
export function planProviderForModel(id: string): PlanProviderId | null {
  const rid = (resolveIntellectModelId(id) ?? id).toLowerCase()
  if (rid.includes('claude') || /\b(opus|sonnet|haiku|fable)\b/.test(rid)) return 'claude'
  if (rid.includes('grok')) return 'cursor'
  return null
}

/**
 * Re-price one grouped frontier candidate against the live plan snapshot. When a
 * plan-billed path covers the model and its governing window has headroom, the
 * candidate plots at $0 with a plan badge (the off-plan price is kept for the
 * hover); when that window is spent, it keeps its real price and carries a
 * limit-reached note instead. Everything else passes through untouched — a null
 * snapshot or an unmapped/uncovered model is never marked included.
 */
export function applyPlanCoverage(
  candidate: FrontierCandidate,
  snapshot: PlanUsageSnapshot | null,
): FrontierCandidate {
  if (!snapshot) return candidate
  const provider = planProviderForModel(candidate.id)
  if (!provider) return candidate
  const inclusion = resolvePlanInclusion(provider, candidate.id, snapshot)
  if (!inclusion) return candidate
  if (inclusion.exhausted) {
    return {
      ...candidate,
      planLimitReached: { label: inclusion.windowLabel, resetsAt: inclusion.resetsAt },
    }
  }
  return {
    ...candidate,
    costPerMTok: 0,
    plan: inclusion.windowLabel,
    planDetail: {
      usedPercent: inclusion.usedPercent,
      resetsAt: inclusion.resetsAt,
      apiPricePerMTok: candidate.costPerMTok,
    },
  }
}

/** Short reset phrase like "resets Tue" from an ISO time, or '' when unknown. */
function resetPhrase(resetsAt: string | null): string {
  if (!resetsAt) return ''
  const d = new Date(resetsAt)
  if (Number.isNaN(d.getTime())) return ''
  const day = d.toLocaleDateString(undefined, { weekday: 'short' })
  return ` (resets ${day})`
}

/**
 * Compact picker/label phrase for a plan-inclusion state: "plan included"
 * while covered (with the tightest window's used-percent so the user can see
 * how close they are), or "plan limit reached (resets …)" once spent.
 */
export function planInclusionHint(inclusion: PlanInclusion): string {
  if (inclusion.exhausted) {
    return `${inclusion.windowLabel} plan limit reached${resetPhrase(inclusion.resetsAt)}`
  }
  return `plan included · ${inclusion.windowLabel} ${String(Math.round(inclusion.usedPercent))}% used`
}
