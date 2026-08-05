// Every URL that might be a model's card, ordered best-first, for a resolver to
// probe. Pure — no I/O, so the ordering policy stays testable and the network
// half lives in the main process.
//
// Why candidates rather than one answer: the same weights appear under several
// id namespaces (a `huggingface:` router id, an OpenRouter `vendor/model`, an
// LM Studio id, a curated catalog id), and which of them can be turned into a
// real card URL differs per model. `model-cards.ts` answers with only what is
// *certain* — a reviewed link, or a Hugging Face path derived from an id HF
// itself gave us — because an unverified guess would ship a 404. A resolver
// that probes each candidate can afford to be less certain, so this list also
// carries the derived forms `getModelCard` refuses to return blind.
//
// Confidence, not just existence: probing proves a URL *resolves*, never that it
// documents the same weights. So candidates are ordered by how strongly the id
// ties to the page, and the first one that resolves wins — a derived guess is
// only ever consulted when everything better has failed.

import { getModelInfo } from './model-catalog.ts'
import { MODEL_CARDS, type ModelCard } from './model-cards.generated.ts'
import { huggingFaceCardUrl, resolveModelCardId } from './model-cards.ts'
import { INTELLECT_ALIASES } from './model-intellect.generated.ts'
import { resolveIntellectModelId } from './model-intellect.ts'

/** How a candidate URL was arrived at. Decides ordering and how it is labelled. */
export type ModelCardOrigin =
  /** A reviewed entry in scripts/data/model-cards.json. */
  | 'curated'
  /** Derived from a `huggingface:` router id — the casing came from the HF API. */
  | 'hf-router'
  /**
   * Derived from the model's canonical catalog id. For open weights that id IS
   * the HF repo path (`zai-org/GLM-5.2`), reviewed casing and all.
   */
  | 'hf-alias'
  /** Derived from another provider's `vendor/model` id. A guess; probe decides. */
  | 'hf-derived'

export interface ModelCardCandidate extends ModelCard {
  origin: ModelCardOrigin
}

/** Two path segments, the shape huggingface.co serves a repo at. */
const HF_REPO_PATH = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/

const ORIGIN_RANK: Record<ModelCardOrigin, number> = {
  curated: 0,
  'hf-router': 1,
  'hf-alias': 2,
  'hf-derived': 3,
}

/**
 * Strip the structural wrappers that never belong to a repo path: a provider
 * prefix, an ACP agent segment, an option suffix, a serving-route tag.
 */
function bareModelPath(id: string): string {
  let s = id.replace(/\[[^\]]*\]$/, '')
  const hash = s.lastIndexOf('#')
  if (hash >= 0) s = s.slice(hash + 1)
  const prefix = s.indexOf(':')
  if (prefix > 0 && !s.slice(0, prefix).includes('/')) s = s.slice(prefix + 1)
  const route = s.lastIndexOf(':')
  if (route > 0 && s.slice(0, route).includes('/')) s = s.slice(0, route)
  return s
}

/**
 * Every id form we know for this model: the id as given, its canonical id, and
 * the aliases curated alongside the intellect measurements (OpenRouter ids, ACP
 * picker labels, provider-prefixed forms). This is the "alias across providers"
 * step — a model with no card under the id in hand may well have one under the
 * name another provider serves it as.
 */
export function modelIdForms(id: string): string[] {
  const forms = new Set<string>([id, bareModelPath(id)])
  const canonical = resolveIntellectModelId(id) ?? resolveModelCardId(id)
  if (canonical !== null) {
    forms.add(canonical)
    for (const [alias, target] of Object.entries(INTELLECT_ALIASES)) {
      if (target === canonical) forms.add(alias)
    }
  }
  return [...forms]
}

/**
 * True when a model is a closed commercial one, so no Hugging Face repo can
 * document it and every HF candidate would be a wrong-model risk rather than a
 * mere 404. `anthropic/claude-opus-4-8` is an OpenRouter route, not an org/repo.
 */
function isClosedCloudModel(id: string): boolean {
  const canonical = resolveIntellectModelId(id) ?? id
  return getModelInfo(canonical) !== null || getModelInfo(id) !== null
}

/**
 * Card URLs worth probing for a model id, best-first and deduplicated by URL.
 * Empty when nothing plausible exists — the caller shows no link rather than a
 * placeholder.
 */
export function modelCardCandidates(id: string): ModelCardCandidate[] {
  const out = new Map<string, ModelCardCandidate>()
  const add = (candidate: ModelCardCandidate): void => {
    const existing = out.get(candidate.url)
    // Keep the strongest justification when two id forms produce one URL.
    if (existing && ORIGIN_RANK[existing.origin] <= ORIGIN_RANK[candidate.origin]) return
    out.set(candidate.url, candidate)
  }

  const curatedId = resolveModelCardId(id)
  const curated = curatedId === null ? undefined : MODEL_CARDS[curatedId]
  if (curated) add({ ...curated, origin: 'curated' })

  const hfCard = (url: string, origin: ModelCardOrigin): ModelCardCandidate => ({
    url,
    title: 'Hugging Face model card',
    publisher: 'Hugging Face',
    kind: 'model-card',
    origin,
  })

  const router = huggingFaceCardUrl(id)
  if (router !== null) add(hfCard(router, 'hf-router'))

  if (!isClosedCloudModel(id)) {
    // The canonical id is the reviewed spelling — for open weights it is the HF
    // repo path itself. The aliases beside it are how OTHER providers spell the
    // same weights (OpenRouter lower-cases and re-orgs: `z-ai/glm-5.2` for
    // `zai-org/GLM-5.2`), so they are guesses and must rank below it.
    const canonicalId = resolveIntellectModelId(id)
    for (const form of modelIdForms(id)) {
      const path = bareModelPath(form)
      if (!HF_REPO_PATH.test(path)) continue
      const origin: ModelCardOrigin = path === canonicalId ? 'hf-alias' : 'hf-derived'
      add(hfCard(`https://huggingface.co/${path}`, origin))
    }
  }

  return [...out.values()].sort((a, b) => ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin])
}
