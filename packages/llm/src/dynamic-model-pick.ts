// Picking a concrete candidate for a dynamic selector.
//
// Separated from `dynamic-model.ts` (the vocabulary) and from the host resolver
// (which knows what the user can route to) so the *judgement* — what "cheapest",
// "most capable", "at least 45" actually mean over a candidate pool — is pure
// and directly testable. The host supplies the pool; this decides the winner.

import type { DynamicModelSelector } from './dynamic-model.ts'
import { pickBestValueFrontierModel, type FrontierPoint } from './pareto-frontier.ts'

/** Median of an ascending-sorted numeric list — the pool's own price centre. */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** A candidate is free at the margin when it runs locally or inside a plan. */
function isFree(point: FrontierPoint): boolean {
  return point.local === true || point.plan !== undefined || point.costPerMTok <= 0
}

/** Highest intellect wins; ties break to the cheaper route, then a stable id. */
function byIntellectDesc(a: FrontierPoint, b: FrontierPoint): number {
  return b.intellect - a.intellect || a.costPerMTok - b.costPerMTok || a.id.localeCompare(b.id)
}

/** Cheapest wins; ties break to the smarter model, then a stable id. */
function byCostAsc(a: FrontierPoint, b: FrontierPoint): number {
  return a.costPerMTok - b.costPerMTok || b.intellect - a.intellect || a.id.localeCompare(b.id)
}

/**
 * The blended $/MTok a candidate is judged at, ignoring any plan discount: a
 * plan-covered model still carries its real API price in `planDetail`, and
 * treating it as free is exactly how Fable slips past a "reasonable price"
 * picker. Local models stay at $0 — they really cost nothing at the margin.
 */
function realApiPrice(point: FrontierPoint): number {
  // A plan-covered route is re-priced to $0 by `applyPlanCoverage`, which
  // records the real API price on `planDetail` — unwrap that BEFORE the
  // `<= 0` guard, or a plan-covered model is judged as free and Fable
  // sneaks past the balanced picker again.
  if (point.plan !== undefined && point.planDetail !== undefined) {
    return point.planDetail.apiPricePerMTok
  }
  // Local models and genuinely $0 routes are free at the margin.
  if (point.local === true || point.costPerMTok <= 0) return point.costPerMTok
  return point.costPerMTok
}

/**
 * Balanced score: intellect minus a price penalty that grows super-linearly,
 * so a model only earns its price when it adds real capability. Compared
 * against the pool's own price spread — a frontier model priced 3× the median
 * pays a heavy penalty, while a $1/MTok model pays almost none.
 */
function balancedScore(point: FrontierPoint, priceMedian: number): number {
  const price = realApiPrice(point)
  const penaltyScale = Math.max(priceMedian, 1)
  const penalty = (price * price) / penaltyScale
  return point.intellect - penalty
}

/**
 * Resolve a selector against a candidate pool. Returns null only when the pool
 * is empty — every other case degrades to *something* routable rather than
 * failing, because a selector that resolves to nothing would silently disable
 * whichever feature stored it.
 *
 * `min-intellect` is the one selector that can be unsatisfiable (nobody
 * configured meets the bar). It then falls back to the most capable candidate:
 * the user asked for "at least this smart", so the closest honest answer is the
 * smartest thing available, not the cheapest.
 */
export function pickDynamicModel(
  selector: DynamicModelSelector,
  pool: readonly FrontierPoint[],
): FrontierPoint | null {
  if (pool.length === 0) return null
  switch (selector.kind) {
    case 'best-value':
      // The frontier-aware pick (plan/local first, then intellect per pound).
      // Falls back to a plain value ranking when nothing sits on the frontier.
      return pickBestValueFrontierModel(pool) ?? [...pool].sort(byIntellectDesc)[0] ?? null
    case 'best-intellect':
      return [...pool].sort(byIntellectDesc)[0] ?? null
    case 'best-local': {
      const local = pool.filter((point) => point.local === true)
      // Nothing loaded on-device: degrade to the cheapest reachable route, which
      // is the closest thing to the "spend nothing" intent behind the choice.
      if (local.length === 0) return [...pool].sort(byCostAsc)[0] ?? null
      return [...local].sort(byIntellectDesc)[0] ?? null
    }
    case 'cheapest': {
      // Everything free costs the same, so prefer the smartest of them.
      const free = pool.filter(isFree)
      if (free.length > 0) return [...free].sort(byIntellectDesc)[0] ?? null
      return [...pool].sort(byCostAsc)[0] ?? null
    }
    case 'min-intellect': {
      const qualified = pool.filter((point) => point.intellect >= selector.threshold)
      if (qualified.length === 0) return [...pool].sort(byIntellectDesc)[0] ?? null
      const free = qualified.filter(isFree)
      return (
        (free.length > 0 ? [...free].sort(byIntellectDesc) : [...qualified].sort(byCostAsc))[0] ??
        null
      )
    }
    case 'balanced': {
      // Real API price, plan discount ignored: a plan-covered Fable is judged
      // at $18/MTok, not $0. Plan-covered routes with headroom still get a
      // small bias — the marginal dollar is already spent, so they cost the
      // user nothing extra even though they aren't literally free.
      const priced = pool.map((point) => ({
        point,
        price: realApiPrice(point),
        covered: point.plan !== undefined && point.planDetail !== undefined,
      }))
      const paidPrices = priced.filter((entry) => entry.price > 0).map((entry) => entry.price)
      const median = paidPrices.length > 0 ? medianOf(paidPrices) : 0
      const ranked = [...priced].sort((a, b) => {
        const scoreA = balancedScore(a.point, median) + (a.covered ? 0.5 : 0)
        const scoreB = balancedScore(b.point, median) + (b.covered ? 0.5 : 0)
        return (
          scoreB - scoreA ||
          b.point.intellect - a.point.intellect ||
          a.point.id.localeCompare(b.point.id)
        )
      })
      return ranked[0]?.point ?? null
    }
    case 'role':
      // Roles resolve through the user's assignments, not the pool — the host
      // handles them before ever reaching here.
      return null
  }
}
