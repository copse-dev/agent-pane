// Canonical *display* naming for models the app did not name itself.
//
// Every provider spells the same Claude or GPT model differently: Cursor's catalog
// returns "Opus 5" and "Claude 4.6 Sonnet (Thinking)", ACP agents return bare
// family names, and some surfaces only have the raw id ("claude-opus-4-7").
// Dropped straight into the picker those sit next to the app's own "Claude Opus
// 4.8" and read as different vendors' models, and under a group heading that
// names an *agent* ("Cursor Cloud Agent") a bare "Opus 5" does not say whose
// Opus it is.
//
// This module rewrites those forms into one house style — `Claude <Family>
// <version>` or `GPT-<version> <variant>`, qualifiers preserved — and nothing else. It is display-only and
// deliberately structural: it reorders and re-spells what a name already says
// and never infers a model from a name it does not recognise, so an unknown
// label is returned untouched rather than guessed at.

/** Anthropic model families, spelled as they appear in a display label. */
const CLAUDE_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const

type ClaudeFamily = (typeof CLAUDE_FAMILIES)[number]

interface ClaudeName {
  family: ClaudeFamily
  /** Dot-separated version, normalised from either `4.6` or id-style `4-6`. */
  version: string
  /** Whatever followed the version ("" or a leading-whitespace qualifier). */
  rest: string
}

const FAMILY_PATTERN = CLAUDE_FAMILIES.join('|')
// Version as either a label ("4.6", "5") or an id fragment ("4-6"). Two
// segments at most, so a dated snapshot id (`claude-haiku-4-5-20251001`) fails
// the qualifier check below and is left alone instead of being read as a
// three-part version.
const VERSION_PATTERN = String.raw`\d+(?:[.-]\d+)?`
// Cursor writes the version before the family: "Claude 4.6 Sonnet (Thinking)".
const VERSION_FIRST = new RegExp(
  String.raw`^claude[\s-]+(${VERSION_PATTERN})[\s-]+(${FAMILY_PATTERN})\b(.*)$`,
  'i',
)
// The house order, with an optional vendor: "Claude Opus 4.8", "Opus 5",
// "claude-opus-4-7", "opus-4-8".
const FAMILY_FIRST = new RegExp(
  String.raw`^(?:claude[\s-]+)?(${FAMILY_PATTERN})[\s-]+(${VERSION_PATTERN})\b(.*)$`,
  'i',
)

// OpenAI ids and display labels use the same pieces with different separators:
// `gpt-5.4-nano`, `GPT-5.6-Sol`, and `GPT-5 mini`. Accept one optional variant
// but reject dated snapshots and other longer ids rather than half-rewriting
// them. `4o` is a version token in its own right.
const GPT_NAME = /^gpt[-\s]+(\d+(?:\.\d+)?[a-z]?)(?:[-\s]+([a-z][a-z0-9]*))?$/i

function canonicalGptLabel(labelOrId: string): string | null {
  const match = GPT_NAME.exec(labelOrId.trim())
  const version = match?.[1]
  if (!version) return null
  const variant = match[2]
  if (!variant) return `GPT-${version.toLowerCase()}`
  const lower = variant.toLowerCase()
  const displayVariant =
    lower === 'mini' || lower === 'nano'
      ? lower
      : `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`
  return `GPT-${version.toLowerCase()} ${displayVariant}`
}

function claudeName(family: string, version: string, rest: string): ClaudeName | null {
  // Only a qualifier the label already separated ("Claude 4.6 Sonnet
  // (Thinking)") is carried over. Anything glued to the version is part of an
  // id we do not model — `claude-opus-4-8-latest`, `claude-fable-5[1m]` — and
  // rewriting half of it would be worse than leaving it alone.
  if (rest !== '' && !/^\s/.test(rest)) return null
  const lower = family.toLowerCase()
  const known = CLAUDE_FAMILIES.find((candidate) => candidate === lower)
  if (!known) return null
  return { family: known, version: version.replace(/-/g, '.'), rest }
}

/** Split a Claude name written in any provider's spelling, or null for the rest. */
function parseClaudeName(value: string): ClaudeName | null {
  const trimmed = value.trim()
  const versionFirst = VERSION_FIRST.exec(trimmed)
  if (versionFirst?.[1] && versionFirst[2]) {
    return claudeName(versionFirst[2], versionFirst[1], versionFirst[3] ?? '')
  }
  const familyFirst = FAMILY_FIRST.exec(trimmed)
  if (familyFirst?.[1] && familyFirst[2]) {
    return claudeName(familyFirst[1], familyFirst[2], familyFirst[3] ?? '')
  }
  return null
}

/**
 * A vendor's model name (or a raw id) in the app's house style: "Opus 5" →
 * "Claude Opus 5", "Claude 4.6 Sonnet (Thinking)" → "Claude Sonnet 4.6
 * (Thinking)", "claude-opus-4-7" → "Claude Opus 4.7", and "gpt-5.4-nano" →
 * "GPT-5.4 nano". Names the app already
 * spells this way pass through unchanged (the rewrite is idempotent), and a
 * name it does not recognise — "Composer 2", a local weight id —
 * is returned exactly as given.
 */
export function canonicalModelLabel(labelOrId: string): string {
  const parsed = parseClaudeName(labelOrId)
  if (parsed) {
    const family = `${parsed.family.charAt(0).toUpperCase()}${parsed.family.slice(1)}`
    return `Claude ${family} ${parsed.version}${parsed.rest}`
  }
  return canonicalGptLabel(labelOrId) ?? labelOrId
}

/**
 * The Anthropic catalog id a display name denotes ("Opus 4.8" →
 * `claude-opus-4-8`), for looking up data keyed on ids when a provider only
 * gave us its own label. Null unless the name is exactly a family and a
 * version: a qualified name ("Claude 4.6 Sonnet (Thinking)") describes a
 * *configuration*, and answering with the plain model's id would attach that
 * model's measurements to a different thing.
 */
export function claudeModelIdFromLabel(labelOrId: string): string | null {
  const parsed = parseClaudeName(labelOrId)
  if (!parsed || parsed.rest.trim() !== '') return null
  return `claude-${parsed.family}-${parsed.version.replace(/\./g, '-')}`
}
