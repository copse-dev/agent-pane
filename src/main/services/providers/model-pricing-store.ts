// The one place the app answers "what does this model cost per token".
//
// Cost estimation used to resolve rates from two sources that between them
// covered neither OpenRouter nor anything else fetched at runtime: the static
// cloud catalog (bare `claude-*` / `gpt-*` ids) and the user's extra-provider
// shortlists (`<slug>:<id>`). An `openrouter:<id>` selection matched neither, so
// the ledger silently priced every OpenRouter turn at $0 — indistinguishable
// from a genuinely free local model.
//
// OpenRouter *does* publish per-token rates, and the app already parses them for
// the model picker; they were simply never persisted anywhere the estimator
// could reach. So: snapshot them to disk on each successful catalog fetch, and
// merge that snapshot with the extra-provider rates behind a single resolver
// that the ledger, the chat footer, and the model-comparison runner all call.
//
// Persisting rather than fetching on demand keeps every read path synchronous
// and offline-safe, and means a model the user ran last month still prices
// correctly after it leaves the catalog.

import {
  mergeModelPricing,
  openRouterPricingMap,
  parseModelPricingMap,
  type ModelPricingMap,
  type PricedCatalogModel,
} from '@copse/llm/model-pricing.ts'
import { extraProviderPricingMap } from '@copse/llm/extra-providers.ts'
import { getSetting, setSetting } from '../storage/settings.ts'
import { getResolvedExtraProviders } from './extra-providers-store.ts'

/** Settings key holding the last-seen OpenRouter catalog rates. */
export const OPENROUTER_PRICING_KEY = 'openRouterPricing'

/** Last-seen OpenRouter rates, keyed `openrouter:<modelId>`. */
export function getPersistedOpenRouterPricing(): ModelPricingMap {
  return parseModelPricingMap(getSetting<unknown>(OPENROUTER_PRICING_KEY, {}))
}

/**
 * Snapshot catalog rates to disk, keeping entries for models that have dropped
 * out of the catalog: the ledger shows a 90-day window, so a model the user ran
 * last month must keep pricing after it is delisted or renamed upstream. Rows
 * still in the catalog win, so a repricing is picked up on the next fetch.
 *
 * A no-op when the fetch produced no priced rows, so a degraded catalog response
 * can never blank a good snapshot.
 */
export async function rememberOpenRouterPricing(
  models: readonly PricedCatalogModel[],
): Promise<void> {
  const fresh = openRouterPricingMap(models)
  if (Object.keys(fresh).length === 0) return
  const merged = mergeModelPricing(getPersistedOpenRouterPricing(), fresh)
  await setSetting(OPENROUTER_PRICING_KEY, merged)
}

/**
 * Every known rate outside the static cloud catalog, keyed by the same model
 * selection string the usage ledger records. Extra providers are merged last so
 * a rate the user typed into the provider form beats a fetched one.
 */
export function resolveModelPricing(): ModelPricingMap {
  return mergeModelPricing(
    getPersistedOpenRouterPricing(),
    extraProviderPricingMap(getResolvedExtraProviders()),
  )
}
