// Compact intellect/cost hints for the model picker — the human-readable face
// of `model-intellect.ts` + `pareto-frontier.ts`. Pure string builders so the
// renderer stays dumb and the wording is unit-testable. Estimated values are
// always prefixed `~` (equated across index versions, quant-adjusted, or a
// composite) — a reader must never mistake a derived number for a measured one;
// the full derivation lives in `explainIntellectScore` / the score's `basis`.

import { compositeIntellect } from './composite-intellect.ts'
import { getLocalModelCapability, localBenchmarkScore } from './local-model-catalog.ts'
import { getModelInfo } from './model-catalog.ts'
import { getIntellectScore } from './model-intellect.ts'
import { blendedPricePerMTok, frontierForKnownModels } from './pareto-frontier.ts'

// The cloud frontier is static per process (catalog + measurements are build-time
// data), so compute it once, lazily.
let cloudFrontierIds: ReadonlySet<string> | null = null
function isOnCloudFrontier(id: string): boolean {
  cloudFrontierIds ??= new Set(
    frontierForKnownModels()
      .filter((p) => p.onFrontier)
      .map((p) => p.id),
  )
  return cloudFrontierIds.has(id)
}

function formatPrice(perMTok: number): string {
  const rounded = Number.isInteger(perMTok) ? String(perMTok) : perMTok.toFixed(2)
  return `$${rounded}/MTok`
}

/**
 * Picker hint for a tracked cloud model, e.g. "intellect 56 · $9/MTok · frontier",
 * or null when the model has neither a sourced intellect score nor pricing
 * (such models render exactly as before). Parts are independent: pricing shows
 * without a score and vice versa.
 */
export function cloudModelIntellectHint(id: string): string | null {
  const score = getIntellectScore(id)
  const info = getModelInfo(id)
  const parts: string[] = []
  if (score) parts.push(`intellect ${score.estimated ? '~' : ''}${String(score.value)}`)
  if (info) parts.push(formatPrice(blendedPricePerMTok(info)))
  if (score && info && isOnCloudFrontier(id)) parts.push('frontier')
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * Intellect-only hint for any model id or label form — OpenRouter ids, ACP
 * picker labels, provider-prefixed values — resolved through the sync data's
 * alias map. No price/frontier parts: those need catalog pricing, which only
 * tracked cloud models have (ACP agents are subscription-billed and expose no
 * token price at all). Null when nothing resolves, so unknown rows render
 * exactly as before.
 */
export function modelIntellectHint(idOrLabel: string): string | null {
  const score = getIntellectScore(idOrLabel)
  if (!score) return null
  return `intellect ${score.estimated ? '~' : ''}${String(score.value)}`
}

/**
 * Intellect hint for a local model as it runs on-device: the quant-adjusted
 * canonical score when one is sourced ("intellect ~55"), else the crystallised
 * composite over its sourced benchmark axes ("composite 58.2 (3 axes)" — its
 * own 0–100 scale, deliberately labelled differently so it is never read as
 * the canonical scale). Null for models with neither.
 */
export function localModelIntellectHint(id: string): string | null {
  const cap = getLocalModelCapability(id)
  if (!cap) return null
  const score = localBenchmarkScore(cap, 'aa-intelligence')
  if (score) return `intellect ${score.estimated ? '~' : ''}${String(score.value)}`
  const composite = compositeIntellect(cap)
  if (composite)
    return `composite ${String(composite.value)} (${String(composite.axes.length)} axes)`
  return null
}
