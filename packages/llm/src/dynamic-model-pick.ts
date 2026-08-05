// Picking a concrete candidate for a dynamic selector.
//
// Separated from `dynamic-model.ts` (the vocabulary) and from the host resolver
// (which knows what the user can route to) so the *judgement* — what "cheapest",
// "most capable", "at least 45" actually mean over a candidate pool — is pure
// and directly testable. The host supplies the pool; this decides the winner.

import type { DynamicModelSelector } from './dynamic-model.ts'
import { pickBestValueFrontierModel, type FrontierPoint } from './pareto-frontier.ts'

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
    case 'role':
      // Roles resolve through the user's assignments, not the pool — the host
      // handles them before ever reaching here.
      return null
  }
}
