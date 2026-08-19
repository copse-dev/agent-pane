// Canonical *display* naming for models the app did not name itself.
//
// Every provider spells the same model differently: Cursor's catalog returns
// "Opus 5" and "Claude 4.6 Sonnet (Thinking)", ACP agents return bare family
// names, and some surfaces only have the raw id ("claude-opus-4-7",
// "gemini-2.5-pro"). Dropped straight into the picker those sit next to the
// app's own "Claude Opus 4.8" and read as different vendors' models, and under
// a group heading that names an *agent* ("Cursor Cloud Agent") a bare "Opus 5"
// does not say whose Opus it is.
//
// This module rewrites those forms into one house style — `Claude <Family>
// <version>`, `GPT-<version> <variant>`, or `Gemini <version> <variant>` (and
// the same for the other named vendors below), qualifiers preserved — and
// nothing else. It is display-only and deliberately structural: it reorders
// and re-spells what a name already says and never infers a model from a name
// it does not recognise, so an unknown label — "Composer 2", a local weight id —
// is returned untouched rather than guessed at.
//
// `modelDisplayName` at the bottom adds the one thing a *picker row* needs on
// top of that: a name it does not recognise still gets spelled as a name rather
// than left as an id, hyphens and all. Copse writes its own annotations onto a
// row with an em dash — an intellect hint, an agent title, a status note — and
// "qwen3guard-gen-8b — intellect 40.6" makes the reader work out which dash is
// the app talking. Callers that need an unrecognised name back verbatim (the
// intellect chart plots 583 measurement ids) keep using `canonicalModelLabel`.

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

// The other named vendors the picker surfaces, each in its own id shape:
//
// - Gemini is `gemini-<version>[-<variant>…]` → `Gemini 2.5 Pro`,
//   `Gemini 2.5 Flash Lite`.
// - GLM keeps the GPT-style hyphen before the version → `GLM-4.6`, `GLM-4.5 Air`.
// - DeepSeek is `deepseek-<name>[-v<version>]` → `DeepSeek Chat`,
//   `DeepSeek Chat V3.1` — the name leads, the version trails.
// - Mistral is `mistral-<tier>[-<qualifier>]` → `Mistral Small Latest`.
//
// Each recognises only its own prefix; an unknown name is left alone, so a
// local weight id (`qwen3.6-35b-a3b`) or another vendor's model ("Composer 2",
// "Grok 4.5") passes through untouched — the same contract the Claude/GPT
// branches keep. `modelDisplayName` is what spells those for a picker row.

/** Title-case a hyphen- or space-separated segment, preserving `mini`/`nano`. */
function titleCaseSegment(segment: string): string {
  return segment
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => {
      const lower = part.toLowerCase()
      if (lower === 'mini' || lower === 'nano') return lower
      return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`
    })
    .join(' ')
}

const GEMINI_NAME = /^gemini-(\d+(?:\.\d+)?)(?:-([a-z].*))?$/
const GLM_NAME = /^glm-(\d+(?:\.\d+)?)(?:-([a-z].*))?$/
const DEEPSEEK_NAME = /^deepseek-([a-z]+)(?:-v(\d+(?:\.\d+)?))?$/
const MISTRAL_NAME = /^mistral-([a-z]+)(?:-([a-z]+))?$/

function canonicalVendorLabel(labelOrId: string): string | null {
  const trimmed = labelOrId.trim()

  const gemini = GEMINI_NAME.exec(trimmed)
  if (gemini) {
    const version = gemini[1] ?? ''
    const variant = gemini[2] ?? ''
    return variant ? `Gemini ${version} ${titleCaseSegment(variant)}` : `Gemini ${version}`
  }

  const glm = GLM_NAME.exec(trimmed)
  if (glm) {
    const version = glm[1] ?? ''
    const variant = glm[2] ?? ''
    return variant ? `GLM-${version} ${titleCaseSegment(variant)}` : `GLM-${version}`
  }

  const deepseek = DEEPSEEK_NAME.exec(trimmed)
  if (deepseek) {
    const name = titleCaseSegment(deepseek[1] ?? '')
    const version = deepseek[2]
    return version ? `DeepSeek ${name} V${version}` : `DeepSeek ${name}`
  }

  const mistral = MISTRAL_NAME.exec(trimmed)
  if (mistral) {
    const tier = titleCaseSegment(mistral[1] ?? '')
    const qualifier = mistral[2] ? ` ${titleCaseSegment(mistral[2])}` : ''
    return `Mistral ${tier}${qualifier}`
  }

  return null
}

// Vendors whose id shapes this module models. Used only to decide whose
// `-latest` is an alias worth preserving (see `keepsDeclinedTail`).
const MODELLED_VENDORS = ['claude', 'gpt', 'gemini', 'glm', 'deepseek', 'mistral'] as const

/** A dated snapshot: `-20251001` or `-2025-08-07`. */
const DATED_SNAPSHOT = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/
/** A bracketed option suffix: `claude-fable-5[1m]`. */
const OPTION_SUFFIX = /\[[^\]]*\]$/

/**
 * Whether an id ends in something a rewrite would silently drop.
 *
 * A dated snapshot and a bracketed option name a *different* configuration from
 * the model they hang off, and a modelled vendor's `-latest` is a moving alias
 * rather than a version — re-spacing any of those reads as a rename of the
 * thing itself. (`-latest` only counts for a vendor whose versions this module
 * models; elsewhere it is just a word, and "Codestral Latest" is honest.)
 */
function keepsDeclinedTail(lower: string): boolean {
  if (OPTION_SUFFIX.test(lower) || DATED_SNAPSHOT.test(lower)) return true
  return lower.endsWith('-latest') && MODELLED_VENDORS.some((v) => lower.startsWith(`${v}-`))
}

// Tokens whose house spelling is not "first letter capitalised": acronyms, and
// the vendor names that carry an internal capital. Everything else is either a
// size (`8b`, `a3b`), a version (`v3`, `k2`, `r1`), or an ordinary word.
const TOKEN_SPELLING: Record<string, string> = {
  ai: 'AI',
  deepseek: 'DeepSeek',
  glm: 'GLM',
  gpt: 'GPT',
  hf: 'HF',
  it: 'IT',
  llm: 'LLM',
  minimax: 'MiniMax',
  moe: 'MoE',
  mpnet: 'MPNet',
  openai: 'OpenAI',
  oss: 'OSS',
  qwq: 'QwQ',
  vl: 'VL',
}

/** `8b` → `8B`, `0.6b` → `0.6B`, `120m` → `120M`: a parameter count. */
const PARAM_COUNT = /^(\d+(?:\.\d+)?)([bkmt])$/
/** `a3b` → `A3B`, `v3` → `V3`, `k2` → `K2`, `r1` → `R1`: a short version or spec code. */
const SHORT_CODE = /^[a-z]\d+[a-z]?$/

function spellToken(token: string): string {
  const lower = token.toLowerCase()
  const known = TOKEN_SPELLING[lower]
  if (known !== undefined) return known
  // House style keeps the small-variant qualifiers lowercase ("GPT-5 mini").
  if (lower === 'mini' || lower === 'nano') return lower
  const param = PARAM_COUNT.exec(lower)
  if (param) return `${param[1] ?? ''}${(param[2] ?? '').toUpperCase()}`
  if (SHORT_CODE.test(lower)) return lower.toUpperCase()
  if (/^[\d.]+$/.test(lower)) return lower
  return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`
}

/**
 * A hyphenated id from a vendor this module does not model, spelled as a name:
 * `qwen3.8-max` → "Qwen3.8 Max", `paraphrase-multilingual-mpnet` → "Paraphrase
 * Multilingual MPNet", `apertus-70b` → "Apertus 70B".
 *
 * The hyphen is the point. Copse writes its own annotations onto a model row
 * with an em dash — the intellect hint, an agent title, a status note — and a
 * name that is itself a run of hyphens ("qwen3guard-gen-8b — intellect 40.6")
 * makes the reader parse which dash is the app talking. Turning the id's own
 * hyphens into spaces leaves the dash meaning one thing.
 *
 * Structural only, like the rest of this module: it re-spaces and re-cases what
 * the id already says and adds nothing. Returned unchanged when there is no id
 * to convert — a name with spaces is already a display name, a path-shaped id
 * (`qwen/qwen3.6-35b-a3b`) is an address whose halves are not ours to merge,
 * and an id ending in a snapshot date, an option, or a modelled vendor's
 * `-latest` alias keeps that tail (see `keepsDeclinedTail`).
 */
function humanizeModelName(labelOrId: string): string {
  const trimmed = labelOrId.trim()
  if (!trimmed.includes('-')) return labelOrId
  if (/\s/.test(trimmed) || trimmed.includes('/')) return labelOrId
  if (keepsDeclinedTail(trimmed.toLowerCase())) return labelOrId
  const tokens = trimmed.split('-').filter((token) => token.length > 0)
  return tokens.reduce((acc, token, i) => {
    const spelled = spellToken(token)
    if (i === 0) return spelled
    // `gpt-5-6-sol` writes one version as two segments. Adjacent bare numbers
    // rejoin as `5.6` rather than splitting into "5 6", which reads as two
    // different models' worth of version.
    const joinsVersion = /^\d+$/.test(token) && /\d$/.test(tokens[i - 1] ?? '')
    return joinsVersion ? `${acc}.${spelled}` : `${acc} ${spelled}`
  }, '')
}

/**
 * The name to *show* for a model id, for surfaces that render a catalog the app
 * did not write: {@link canonicalModelLabel}'s house style when it recognises
 * the name, else the structural spelling from {@link humanizeModelName}.
 *
 * Kept separate from `canonicalModelLabel` because the two answer different
 * questions. `canonicalModelLabel` is asked "is this one of ours, spelled
 * differently?" and must say "not mine" for anything else — the intellect
 * chart plots 583 measurement ids through it and needs them back verbatim.
 * This is asked "what goes in this row?", where an id is never the right
 * answer.
 */
export function modelDisplayName(labelOrId: string): string {
  const canonical = canonicalModelLabel(labelOrId)
  return canonical === labelOrId ? humanizeModelName(labelOrId) : canonical
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
 * (Thinking)", "claude-opus-4-7" → "Claude Opus 4.7", "gpt-5.4-nano" →
 * "GPT-5.4 nano", and "gemini-2.5-pro" → "Gemini 2.5 Pro". Names the app already
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
  return canonicalGptLabel(labelOrId) ?? canonicalVendorLabel(labelOrId) ?? labelOrId
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
