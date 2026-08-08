// The single vocabulary for "what does a million tokens of this model cost".
//
// Rates reach the cost estimator from three independent places, and every one of
// them is keyed by the same `<selection>` string the usage ledger records:
//
//   1. the generated cloud catalog (`model-catalog.generated.ts`), keyed by bare
//      tracked ids (`claude-sonnet-4-6`);
//   2. the user's extra-provider model shortlists, keyed `<slug>:<modelId>` and
//      persisted with the provider record;
//   3. the OpenRouter catalog, keyed `openrouter:<modelId>` and persisted by the
//      app after each successful catalog fetch (see model-pricing-store.ts).
//
// Keeping the shape, the merge, and the persisted-JSON parse in one module is
// what lets `estimate-cost.ts` stay a single lookup rather than growing a branch
// per provider family — and is why a newly-supported route only has to produce a
// `ModelPricingMap` to start showing real costs in the ledger.

import { OPENROUTER_MODEL_PREFIX } from './openrouter.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface ModelPricing {
  /** USD per million input tokens. */
  inputPricePerMTok: number
  /** USD per million output tokens. */
  outputPricePerMTok: number
  /** USD per million cache-read input tokens; falls back to the input rate. */
  cacheReadPricePerMTok?: number
  /** USD per million cache-write input tokens; falls back to the input rate. */
  cacheCreationPricePerMTok?: number
}

/** `model selection → pricing`, keyed exactly as the usage ledger records models. */
export type ModelPricingMap = Record<string, ModelPricing>

/**
 * A catalog row that may or may not carry rates. `null` means "the catalog did
 * not report a rate" — distinct from `0`, which is a real (free) route and is
 * kept, so a free model prices as an actual zero instead of falling through the
 * estimator as unknown.
 */
export interface PricedCatalogModel {
  id: string
  inputPricePerMTok: number | null
  outputPricePerMTok: number | null
  cacheReadPricePerMTok?: number | null
  cacheCreationPricePerMTok?: number | null
}

/**
 * Cap on persisted entries. OpenRouter's catalog is a few hundred tool-capable
 * models today; the cap is headroom that keeps a malformed or hostile settings
 * file from growing the store without bound.
 */
export const MAX_PRICING_ENTRIES = 4096

function rate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Keep only the rate fields, dropping absent optionals so entries stay compact. */
function toPricing(
  input: number,
  output: number,
  cacheRead: number | null,
  cacheCreation: number | null,
): ModelPricing {
  return {
    inputPricePerMTok: input,
    outputPricePerMTok: output,
    ...(cacheRead !== null ? { cacheReadPricePerMTok: cacheRead } : {}),
    ...(cacheCreation !== null ? { cacheCreationPricePerMTok: cacheCreation } : {}),
  }
}

/**
 * Catalog rows → a pricing map keyed `openrouter:<modelId>`, matching how an
 * OpenRouter selection is stored in thread usage and the ledger. Rows missing
 * either headline rate are skipped rather than defaulted, so an unpriced model
 * stays unpriced instead of silently reading as free.
 */
export function openRouterPricingMap(models: readonly PricedCatalogModel[]): ModelPricingMap {
  const out: ModelPricingMap = {}
  for (const model of models) {
    const input = rate(model.inputPricePerMTok)
    const output = rate(model.outputPricePerMTok)
    if (input === null || output === null) continue
    out[`${OPENROUTER_MODEL_PREFIX}${model.id}`] = toPricing(
      input,
      output,
      rate(model.cacheReadPricePerMTok),
      rate(model.cacheCreationPricePerMTok),
    )
  }
  return out
}

/** Merge pricing sources into one map; later sources win on a shared key. */
export function mergeModelPricing(
  ...maps: ReadonlyArray<ModelPricingMap | undefined | null>
): ModelPricingMap {
  const out: ModelPricingMap = {}
  for (const map of maps) {
    if (!map) continue
    Object.assign(out, map)
  }
  return out
}

/**
 * Parse a persisted pricing map. This is cache data read back off disk, so it
 * validates entry by entry and drops anything malformed instead of throwing —
 * a corrupt cache should cost accuracy, never a failed Settings load.
 */
export function parseModelPricingMap(raw: unknown): ModelPricingMap {
  if (!isRecord(raw)) return {}
  const out: ModelPricingMap = {}
  let kept = 0
  for (const [model, value] of Object.entries(raw)) {
    if (kept >= MAX_PRICING_ENTRIES) break
    if (!model || !isRecord(value)) continue
    const input = rate(value['inputPricePerMTok'])
    const output = rate(value['outputPricePerMTok'])
    if (input === null || output === null) continue
    out[model] = toPricing(
      input,
      output,
      rate(value['cacheReadPricePerMTok']),
      rate(value['cacheCreationPricePerMTok']),
    )
    kept += 1
  }
  return out
}
