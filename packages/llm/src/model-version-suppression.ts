// Hide an older cloud model from the picker when the same picker offers its
// direct successor.
//
// Every tracked release stays in the catalog (saved threads keep running on it),
// but a picker that lists Sonnet 4.6, Sonnet 5 and Sonnet 5.5 side by side asks
// the user to know release history. The successor rule is deliberately narrow so
// that nothing the user might actually want disappears:
//
// - Same *lineage* only. For Claude that is the family name (`claude-opus`,
//   `claude-sonnet`, …); for OpenAI it is the tier suffix (`gpt`, `gpt-mini`,
//   `gpt-sol`, `gpt-astra`, …). A newer model of a different tier is a different
//   product — GPT-6.1 Sol does not stand in for GPT-6 Astra, GPT-5.6 Sol does not
//   stand in for GPT-5 nano — so it never hides one.
// - Strictly newer numeric version within that lineage. `gpt-4o` carries no
//   numeric version in this sense and is left alone, as is any dated snapshot or
//   other id the pattern does not fully claim.
// - The successor has to be *offered in the same list*. Availability is the
//   caller's: an account-gated or keyless successor the picker is not showing
//   cannot hide a model the user can run, and a namespaced route
//   (`openrouter:…`, `acp:…`) is never compared at all.
//
// The caller keeps a superseded model that is still the current selection, so a
// saved choice is explained rather than silently swapped.

interface ModelLineage {
  /** Models that replace one another: `claude-opus`, `gpt`, `gpt-mini`, `gpt-sol`. */
  readonly lineage: string
  /** Numeric version segments: `claude-opus-5-5` → [5, 5], `gpt-5.6-sol` → [5, 6]. */
  readonly version: readonly number[]
}

// A bare tracked-style Anthropic id: family then a one- or two-segment version
// and nothing else, so `claude-haiku-4-5-20251001` (a dated snapshot) and
// `claude-mythos-preview` are not claimed.
const CLAUDE_ID = /^claude-(opus|sonnet|haiku|fable)-(\d{1,2}(?:-\d{1,2})?)$/
// A bare OpenAI id: numeric version with an optional dotted minor, then an
// optional lower-case tier word. `gpt-4o` fails the version, `gpt-5-2025-08-07`
// fails the tier, `gpt-5-chat-latest` fails the anchor.
const GPT_ID = /^gpt-(\d{1,2}(?:\.\d{1,2})?)(?:-([a-z][a-z0-9]*))?$/

function parseModelLineage(id: string): ModelLineage | null {
  const claude = CLAUDE_ID.exec(id)
  if (claude) {
    const family = claude[1]
    const version = claude[2]
    if (family === undefined || version === undefined) return null
    return { lineage: `claude-${family}`, version: version.split('-').map(Number) }
  }
  const gpt = GPT_ID.exec(id)
  if (gpt) {
    const version = gpt[1]
    if (version === undefined) return null
    const tier = gpt[2]
    return {
      lineage: tier === undefined ? 'gpt' : `gpt-${tier}`,
      version: version.split('.').map(Number),
    }
  }
  return null
}

/** Segment-wise comparison with missing segments read as 0: [5] < [5, 5] < [6]. */
function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * The newest model in `offered` that is a direct successor of `model` — same
 * lineage, strictly newer version — or `null` when `model` is not a versioned
 * cloud id, or no such successor is offered.
 */
export function supersedingModel(model: string, offered: Iterable<string>): string | null {
  const own = parseModelLineage(model)
  if (own === null) return null
  let best: { id: string; version: readonly number[] } | null = null
  for (const candidate of offered) {
    if (candidate === model) continue
    const parsed = parseModelLineage(candidate)
    if (parsed === null || parsed.lineage !== own.lineage) continue
    if (compareVersions(parsed.version, own.version) <= 0) continue
    if (best === null || compareVersions(parsed.version, best.version) > 0) {
      best = { id: candidate, version: parsed.version }
    }
  }
  return best?.id ?? null
}
