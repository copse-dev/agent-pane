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
import { getIntellectScore } from './model-intellect.ts'

/** Blended USD per million tokens at the 80/20 input:output mix. */
export function blendedPricePerMTok(info: ModelInfo): number {
  return 0.8 * info.inputPricePerMTok + 0.2 * info.outputPricePerMTok
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
 * The frontier over every tracked cloud model that has BOTH catalog pricing and
 * a canonical intellect score (models missing either are skipped, never
 * invented), plus any extra candidates the caller supplies (e.g. loaded local
 * models whose quant-adjusted intellect came via `localBenchmarkScore`).
 */
export function frontierForKnownModels(extra: readonly FrontierCandidate[] = []): FrontierPoint[] {
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
  return computeParetoFrontier([...cloud, ...extra])
}
