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
 * Resolve any wrapped id form to the catalog id `direct` recognises, or null
 * when nothing resolves. `direct` is called with progressively-unwrapped
 * candidates and returns the catalog id for a candidate it knows, else null.
 */
export function resolveModelIdForm(
  id: string,
  direct: (candidate: string) => string | null,
): string | null {
  const hit = direct(id)
  if (hit !== null) return hit
  // Option suffix: `<model>[...]` (e.g. "[1m]", "[fast=true]").
  const unbracketed = id.replace(/\[[^\]]*\]$/, '')
  if (unbracketed !== id) return resolveModelIdForm(unbracketed, direct)
  // ACP form `<agent>#<model>`: the model is the part after the last '#'.
  const hash = id.lastIndexOf('#')
  if (hash >= 0) return resolveModelIdForm(id.slice(hash + 1), direct)
  // Provider prefix `<provider>:<rest>`.
  const sep = id.indexOf(':')
  if (sep > 0) {
    const stripped = resolveModelIdForm(id.slice(sep + 1), direct)
    if (stripped !== null) return stripped
  }
  // Serving-route tag on a vendor path: `vendor/model:tag` (only when a '/'
  // remains, so a bare word after a colon is never mistaken for a model).
  const lastColon = id.lastIndexOf(':')
  if (lastColon > 0 && id.slice(0, lastColon).includes('/')) {
    return resolveModelIdForm(id.slice(0, lastColon), direct)
  }
  return null
}
