// Structural unwrapping for model-selection ids, shared by every lookup table
// keyed on a model's *catalog* id (intellect measurements, model cards).
//
// Copse encodes a chosen model with several structural wrappers layered over
// the upstream id: provider prefixes (`lmstudio:<id>`, `huggingface:<org>/
// <model>`), ACP agent segments (`acp:<agent>#<model>`), option suffixes
// (`claude-fable-5[1m]`), and serving-route tags on a vendor path
// (`MiniMaxAI/MiniMax-M3:novita`). A table keyed on the bare id has to peel
// those off to find its entry.
//
// Peeling is deliberately structural only — the model name itself is never
// fuzzy-matched, so `gpt-5-mini` can never resolve to `gpt-5`'s data. Callers
// supply `direct`, which decides what counts as a hit for their table (an exact
// key, an alias, …) and returns the catalog id, or null to keep unwrapping.

/**
 * Candidates one resolution may consider before giving up.
 *
 * Every step peels one wrapper, and the wrappers are a closed set, so a real id
 * — even `acp:agent#provider:vendor/model:tag[1m]`, with all of them stacked —
 * settles in under a dozen candidates. The ceiling is two orders of magnitude
 * above that, so it can only be reached by a string that is not a model id at
 * all: a colon-dense one where both colon rules keep firing, which costs a
 * candidate per pair of colons.
 */
const MAX_CANDIDATES = 256

interface Search {
  direct: (candidate: string) => string | null
  /** Candidates already proven unresolvable, so a later branch skips them. */
  exhausted: Set<string>
  /** Candidates left in this resolution's budget. */
  budget: number
}

/**
 * Resolve any wrapped id form to the catalog id `direct` recognises, or null
 * when nothing resolves. `direct` is called with progressively-unwrapped
 * candidates and returns the catalog id for a candidate it knows, else null.
 */
export function resolveModelIdForm(
  id: string,
  direct: (candidate: string) => string | null,
): string | null {
  return unwrap(id, { direct, exhausted: new Set(), budget: MAX_CANDIDATES })
}

/**
 * One unwrapping step, skipping candidates an earlier branch already exhausted.
 *
 * The two colon rules below both recurse and the provider-prefix rule keeps
 * going when its branch comes back empty, so the search fans out over every
 * interleaving of "drop a leading segment" and "drop a trailing tag". Left
 * alone, that fan-out is exponential: `a/b:a/b:…` with 24 segments — a
 * 95-character id, well within what a model listing can carry — took 16.7M
 * calls and 1.9s on the process that asked for a lookup.
 *
 * `direct` is a pure table probe, so a candidate that came back null once will
 * do so again. Remembering that collapses the search to the distinct candidates
 * themselves, and {@link MAX_CANDIDATES} bounds how many of those a single
 * resolution will look at. Neither changes what resolves: the memo only prunes
 * branches already proven empty, and no id shaped like a model id comes close
 * to the ceiling.
 */
function unwrap(id: string, search: Search): string | null {
  if (search.exhausted.has(id) || search.budget <= 0) return null
  search.budget -= 1
  const resolved = unwrapUncached(id, search)
  if (resolved === null) search.exhausted.add(id)
  return resolved
}

function unwrapUncached(id: string, search: Search): string | null {
  const hit = search.direct(id)
  if (hit !== null) return hit
  // Option suffix: `<model>[...]` (e.g. "[1m]", "[fast=true]").
  const unbracketed = id.replace(/\[[^\]]*\]$/, '')
  if (unbracketed !== id) return unwrap(unbracketed, search)
  // ACP form `<agent>#<model>`: the model is the part after the last '#'.
  const hash = id.lastIndexOf('#')
  if (hash >= 0) return unwrap(id.slice(hash + 1), search)
  // Provider prefix `<provider>:<rest>`.
  const sep = id.indexOf(':')
  if (sep > 0) {
    const stripped = unwrap(id.slice(sep + 1), search)
    if (stripped !== null) return stripped
  }
  // Serving-route tag on a vendor path: `vendor/model:tag` (only when a '/'
  // remains, so a bare word after a colon is never mistaken for a model).
  const lastColon = id.lastIndexOf(':')
  if (lastColon > 0 && id.slice(0, lastColon).includes('/')) {
    return unwrap(id.slice(0, lastColon), search)
  }
  return null
}
