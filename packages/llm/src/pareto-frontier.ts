// The intellect-vs-cost Pareto frontier: which models are worth their price?
// A model is ON the frontier when no other candidate is at least as smart for
// less money — everything below the frontier is dominated (you could pay less
// for equal-or-better intellect). Intellect values MUST all be on the canonical
// Intelligence Index scale (`model-intellect.ts`); mixing scales would make the
// dominance test meaningless, which is why composite-only models
// (`composite-intellect.ts`) are excluded rather than plotted.
//
// Cost is the blended token price at an 80% input / 20% output mix — the split
// industry cost-per-token comparisons use (e.g. Artificial Analysis' blended
// price; it reproduces their published $9/MTok for Opus 4.8 from its $5/$25
// list prices). Cost per *task* additionally depends on verbosity and is a
// future synced column, not derivable from list prices. Local models run at
// zero marginal token cost — they carry `local: true` so surfaces can label
// them "free (local)" instead of implying a cloud price of $0.

import { TRACKED_MODELS, getModelInfo, type ModelInfo } from './model-catalog.ts'
import { getIntellectScore, resolveIntellectModelId } from './model-intellect.ts'

/** Blended USD per million tokens at the 80/20 input:output mix. */
export function blendedRate(inputPerMTok: number, outputPerMTok: number): number {
  return 0.8 * inputPerMTok + 0.2 * outputPerMTok
}

/** {@link blendedRate} over a catalog entry. */
export function blendedPricePerMTok(info: ModelInfo): number {
  return blendedRate(info.inputPricePerMTok, info.outputPricePerMTok)
}

export interface FrontierCandidate {
  id: string
  /** Intellect on the canonical Intelligence Index scale. */
  intellect: number
  /** True when the intellect value is an estimate (equated / quant-adjusted). */
  intellectEstimated?: boolean
  /** Blended USD per million tokens (0 for local models). */
  costPerMTok: number
  /** Runs on-device at zero marginal token cost. */
  local?: boolean
  /** Quantisation the model runs at locally, when known (e.g. "Q4_K_M"). */
  quant?: string
  /**
   * Other offerings of the SAME weights at worse prices, folded in when
   * candidates are grouped by model identity — the chart plots the best
   * price; these surface in the tooltip.
   */
  prices?: ReadonlyArray<{ id: string; costPerMTok: number }>
  /**
   * A model the user can't route to today — available via Artificial Analysis
   * but needing a provider set up. Plotted only when discovery is toggled on,
   * and styled distinctly.
   */
  discovery?: boolean
  /** Covered by a subscription (e.g. "Claude Max"): ~$0 marginal, fixed fee. */
  plan?: string
  /**
   * Plan-coverage detail for the hover when `plan` is set: how much of the
   * governing window is used, its reset, and the price you'd pay off-plan (the
   * blended rate this candidate would otherwise plot at). The renderer sets
   * this from the live usage snapshot; the frontier never interprets it.
   */
  planDetail?: { usedPercent: number; resetsAt: string | null; apiPricePerMTok: number }
  /**
   * Set instead of `plan` when the governing plan window is spent: the model is
   * plotted at its real price (no `plan` badge), with this note explaining why
   * it stopped being included.
   */
  planLimitReached?: { label: string; resetsAt: string | null }
  /** AA's own cost-per-Intelligence-Index-task in USD, when the feed carries it. */
  costPerTask?: number
  /**
   * Blended $/MTok when {@link costPerMTok} has been remapped onto another cost
   * axis (e.g. cost-per-task). Tooltips still disclose list price from this.
   */
  blendedCostPerMTok?: number
}

/** X-axis for the intellect-vs-cost value map. */
export type FrontierCostAxis = 'blended' | 'perTask'

/**
 * Cost coordinate for the chosen X axis. Null when the candidate cannot be
 * placed on that axis (per-task mode without a positive `costPerTask`, and not
 * free via local/plan).
 */
export function costOnAxis(
  c: Pick<FrontierCandidate, 'costPerMTok' | 'costPerTask' | 'local' | 'plan'>,
  axis: FrontierCostAxis,
): number | null {
  if (axis === 'blended') return c.costPerMTok
  // Free-on-axis: local and plan-included still sit at $0 on the task axis.
  if (c.local || c.plan) return 0
  if (typeof c.costPerTask === 'number' && Number.isFinite(c.costPerTask) && c.costPerTask > 0) {
    return c.costPerTask
  }
  return null
}

/**
 * Remap candidates so `costPerMTok` is the plot cost for `axis`. When remapping
 * to per-task, the prior blended list price is preserved on `blendedCostPerMTok`
 * for tooltips. Candidates that cannot sit on the axis are returned separately.
 */
export function projectOntoCostAxis(
  candidates: readonly FrontierCandidate[],
  axis: FrontierCostAxis,
): { plotted: FrontierCandidate[]; missingAxisCost: FrontierCandidate[] } {
  if (axis === 'blended') {
    return { plotted: [...candidates], missingAxisCost: [] }
  }
  const plotted: FrontierCandidate[] = []
  const missingAxisCost: FrontierCandidate[] = []
  for (const c of candidates) {
    const cost = costOnAxis(c, axis)
    if (cost === null) {
      missingAxisCost.push(c)
      continue
    }
    const priorBlended =
      c.blendedCostPerMTok ??
      (c.planDetail !== undefined ? c.planDetail.apiPricePerMTok : c.costPerMTok)
    const next: FrontierCandidate = {
      ...c,
      costPerMTok: cost,
    }
    // Only stash blended when the plot cost left the list-price axis.
    if (cost !== priorBlended || c.plan || c.local) {
      next.blendedCostPerMTok = priorBlended
    }
    plotted.push(next)
  }
  return { plotted, missingAxisCost }
}

export interface FrontierPoint extends FrontierCandidate {
  onFrontier: boolean
  /** For a dominated point: a cheaper-or-equal candidate with ≥ intellect. */
  dominatedBy?: string
}

/**
 * Annotate candidates with their frontier position. Returned sorted by cost
 * ascending (ties: higher intellect first, then id) — plot-ready order.
 * Deterministic: no I/O, no clock. A candidate tying another on both axes is
 * marked dominated by it (the first by id wins), so duplicates don't widen the
 * frontier.
 */
export function computeParetoFrontier(candidates: readonly FrontierCandidate[]): FrontierPoint[] {
  const sorted = [...candidates].sort(
    (a, b) =>
      a.costPerMTok - b.costPerMTok || b.intellect - a.intellect || a.id.localeCompare(b.id),
  )
  const out: FrontierPoint[] = []
  let best: FrontierPoint | null = null
  for (const c of sorted) {
    if (best && c.intellect <= best.intellect) {
      out.push({ ...c, onFrontier: false, dominatedBy: best.id })
      continue
    }
    const point: FrontierPoint = { ...c, onFrontier: true }
    out.push(point)
    best = point
  }
  return out
}

/**
 * Group candidates that are the SAME weights (identity via
 * {@link resolveIntellectModelId}, falling back to the raw id): the cheapest
 * offering becomes the point, the rest fold into its `prices` list. A worse
 * price for identical weights is dominated by definition — plotting it would
 * only add noise.
 */
export function groupByModelIdentity(
  candidates: readonly FrontierCandidate[],
): FrontierCandidate[] {
  const groups = new Map<string, FrontierCandidate[]>()
  for (const c of candidates) {
    const key = resolveIntellectModelId(c.id) ?? c.id
    const list = groups.get(key) ?? []
    list.push(c)
    groups.set(key, list)
  }
  const out: FrontierCandidate[] = []
  for (const list of groups.values()) {
    const sorted = [...list].sort(
      (a, b) => a.costPerMTok - b.costPerMTok || a.id.localeCompare(b.id),
    )
    const best = sorted[0]
    if (!best) continue
    const others = sorted.slice(1).map((c) => ({ id: c.id, costPerMTok: c.costPerMTok }))
    out.push(others.length > 0 ? { ...best, prices: others } : best)
  }
  return out
}

/**
 * The frontier over every tracked cloud model that has BOTH catalog pricing and
 * a canonical intellect score (models missing either are skipped, never
 * invented), plus any extra candidates the caller supplies (e.g. loaded local
 * models whose quant-adjusted intellect came via `localBenchmarkScore`).
 * Offerings of the same weights are grouped: best price plots, the rest ride
 * along in `prices`.
 */
export function frontierForKnownModels(
  extra: readonly FrontierCandidate[] = [],
  adjust?: (candidate: FrontierCandidate) => FrontierCandidate,
): FrontierPoint[] {
  const cloud: FrontierCandidate[] = []
  for (const id of TRACKED_MODELS) {
    const info = getModelInfo(id)
    const score = getIntellectScore(id)
    if (!info || !score) continue
    cloud.push({
      id,
      intellect: score.value,
      intellectEstimated: score.estimated === true,
      costPerMTok: blendedPricePerMTok(info),
    })
  }
  // Group first (best price per identity), then let the caller re-price each
  // representative — e.g. drop a plan-covered model's cost to $0. Adjusting the
  // grouped candidate (not each raw offering) applies coverage once per model.
  const grouped = groupByModelIdentity([...cloud, ...extra])
  return computeParetoFrontier(adjust ? grouped.map(adjust) : grouped)
}
