// Public API for model cards / system cards: "where did this model's own vendor
// document it?". The documentation axis alongside `model-catalog.ts` (price),
// `model-intellect.ts` (capability) and `data-policies.ts` (where prompts go) —
// so a user weighing a model on the value map can read the vendor's own
// evaluation instead of taking a number on trust.
//
// The data lives in `model-cards.generated.ts`, rewritten by
// `scripts/sync-model-cards.mts` from the reviewed file
// `scripts/data/model-cards.json`. To add a model:
//
//   1. Add a `cards` entry (a real, cited URL) or a `wanted` entry to
//      scripts/data/model-cards.json.
//   2. Run `npm run sync:model-cards` (add `--discover` to fetch a `wanted`
//      model's card from its vendor, `--verify` to check every link resolves).
//
// SOURCING RULE — a card link is a fact, never a guessed slug. An unsourced
// model has no card and the UI shows no link; a 404 would be worse than that.

import { resolveModelIdForm } from './model-id-forms.ts'
import { resolveIntellectModelId } from './model-intellect.ts'
import { MODEL_CARDS, type ModelCard, type ModelCardKind } from './model-cards.generated.ts'

export { MODEL_CARDS }
export type { ModelCard, ModelCardKind }

/**
 * Model-selection prefix for the Hugging Face Inference Providers router
 * (`huggingface:<org>/<model>[:routing]`). Mirrors the built-in provider's
 * `prefix` in `extra-providers.ts`; kept as a literal here so this module stays
 * a leaf (the card lookup must not pull in the provider registry).
 */
const HF_ROUTER_PREFIX = 'huggingface:'

/** An HF repo path: `org/model`, the two path segments huggingface.co serves. */
const HF_REPO_PATH = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/

/**
 * The Hugging Face model card for a router id, or null.
 *
 * On Hugging Face the repo README *is* the model card, so the URL is derivable
 * rather than data — but only for ids that came from the HF router, whose
 * `org/model` casing is what the HF API itself returned. Deliberately NOT
 * applied to bare `vendor/model` ids: the local catalog stores lower-cased
 * approximations (`qwen/qwen3.6-35b-a3b`) and OpenRouter has its own namespace,
 * and huggingface.co paths are case-sensitive, so deriving from those would
 * manufacture 404s.
 */
export function huggingFaceCardUrl(id: string): string | null {
  if (!id.startsWith(HF_ROUTER_PREFIX)) return null
  const rest = id.slice(HF_ROUTER_PREFIX.length)
  // Strip the routing suffix (`:fastest`, `:deepinfra`) — it selects a serving
  // partner, not a different set of weights.
  const lastColon = rest.lastIndexOf(':')
  const repo = lastColon > 0 ? rest.slice(0, lastColon) : rest
  if (!HF_REPO_PATH.test(repo)) return null
  return `https://huggingface.co/${repo}`
}

/**
 * The canonical id a card is filed under, for any wrapped/alias id form, or
 * null. Tries the card table's own keys first, then the intellect alias table —
 * which already carries every OpenRouter id and ACP picker label a model
 * appears under, so those alias lists live in exactly one place.
 */
export function resolveModelCardId(id: string): string | null {
  const direct = resolveModelIdForm(id, (candidate) =>
    candidate in MODEL_CARDS ? candidate : null,
  )
  if (direct !== null) return direct
  const viaIntellect = resolveIntellectModelId(id)
  return viaIntellect !== null && viaIntellect in MODEL_CARDS ? viaIntellect : null
}

/**
 * The vendor-published card for a model id in any form the app uses, or null
 * when none is sourced. Null is the normal case for most of the open-weight
 * catalog and must render as "no link", never as a placeholder.
 */
export function getModelCard(id: string): ModelCard | null {
  const resolved = resolveModelCardId(id)
  if (resolved !== null) {
    const card = MODEL_CARDS[resolved]
    if (card) return card
  }
  const hf = huggingFaceCardUrl(id)
  if (hf === null) return null
  return {
    url: hf,
    title: 'Hugging Face model card',
    publisher: 'Hugging Face',
    kind: 'model-card',
  }
}
