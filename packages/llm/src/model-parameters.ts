// Per-model generation parameters the user can tune: reasoning depth,
// temperature, and top-p.
//
// A model selection already carries a *route* (`parseModelSelection`); this
// module adds what that route will *accept*. The three knobs are not universal
// — the same word means a different wire field on each family, and several
// families reject the ones they don't implement with a 400 rather than ignoring
// them:
//
//   - Anthropic's newest models (Opus 5 / 4.8 / 4.7, Sonnet 5, Fable 5) removed
//     `temperature` / `top_p` outright, and control reasoning with
//     `output_config.effort` — a named ladder, not a token budget.
//   - Anthropic's 4.6 generation still accepts sampling, and its effort ladder
//     stops at `high`/`max` (no `xhigh`).
//   - Older Claude models have no `effort` at all: reasoning there is
//     `thinking.budget_tokens`, a token count derived from `max_tokens`.
//   - OpenAI's reasoning models take `reasoning_effort` and reject non-default
//     sampling; `gpt-4o` is the mirror image.
//   - Every OpenAI-compatible endpoint (OpenRouter, local servers, extra
//     providers) speaks `reasoning_effort` but supports a vendor-specific slice
//     of it, so those get the full ladder and the honest caveat that the
//     upstream model decides.
//
// So the exported surface is: one vocabulary (`ReasoningLevel`), one capability
// query (`modelParameterSupport`) that says which levels and which sampling a
// selection accepts, and per-family mappers that turn a sanitized
// `ModelParameters` into request fields. Callers store the vocabulary; the
// mappers own the wire.

import { anthropicMaxOutputTokens } from './model-catalog.ts'
import { parseModelSelection, type ModelNamespace } from './model-selection.ts'

/**
 * Reasoning depth, ordered cheapest-first. `off` asks the model not to reason
 * at all; the rest name a depth. Not every level reaches every model — see
 * {@link modelParameterSupport}, which returns the accepted subset.
 */
export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return REASONING_LEVELS.some((level) => level === value)
}

/**
 * User-chosen generation parameters for one model selection. Every field is
 * optional and an absent field means "send nothing" — the provider default,
 * not a value of our choosing. That distinction matters: a model's own default
 * temperature is not necessarily 1, and sending 1 is not the same as omitting.
 */
export interface ModelParameters {
  reasoning?: ReasoningLevel
  temperature?: number
  topP?: number
  topK?: number
  minP?: number
  presencePenalty?: number
  repetitionPenalty?: number
}

/**
 * The sampling knobs, as `ModelParameters` field names.
 *
 * Ordered as a user reads them: the two every route understands, then the
 * truncation cutoffs, then the repetition controls. {@link modelParameterSupport}
 * returns a subset of this list, because support is per-field rather than
 * all-or-nothing — `top_k` and `min_p` are not OpenAI parameters at all, while
 * `presence_penalty` is one but has no Anthropic equivalent.
 */
export const SAMPLING_FIELDS = [
  'temperature',
  'topP',
  'topK',
  'minP',
  'presencePenalty',
  'repetitionPenalty',
] as const

export type SamplingField = (typeof SAMPLING_FIELDS)[number]

/** True when no knob is set, i.e. the request goes out exactly as before. */
export function isEmptyModelParameters(params: ModelParameters): boolean {
  return (
    params.reasoning === undefined && SAMPLING_FIELDS.every((field) => params[field] === undefined)
  )
}

/**
 * How a family expresses reasoning on the wire. The UI never sees this — it
 * asks for levels and gets levels — but the mappers dispatch on it.
 */
export type ReasoningWire =
  /** Anthropic `output_config.effort` (+ `thinking: disabled` for `off`). */
  | 'anthropic-effort'
  /** Anthropic `thinking.budget_tokens`, derived from the model's max output. */
  | 'anthropic-budget'
  /** OpenAI-shaped `reasoning_effort`. */
  | 'openai-effort'
  /** OpenRouter's unified `reasoning: { effort }` / `reasoning: { enabled }`. */
  | 'openrouter'
  /** No reasoning control at all. */
  | 'none'

export interface ModelParameterSupport {
  /** Reasoning levels this selection accepts, cheapest-first; empty when none. */
  reasoning: readonly ReasoningLevel[]
  /** How an accepted level reaches the provider. */
  reasoningWire: ReasoningWire
  /** Sampling knobs this selection accepts; empty when it takes none. */
  sampling: readonly SamplingField[]
  /** Upper bound for `temperature` (Anthropic caps at 1, OpenAI-shaped at 2). */
  temperatureMax: number
  /**
   * Set when the provider — not the model — decides which levels actually
   * work, so the UI can say so rather than implying every level is verified.
   */
  upstreamDecides?: boolean
  /**
   * Set when the selection takes no parameters at all, explaining why. Agents
   * (device, cloud, pack routes) run the whole turn themselves and are
   * configured where they live, not here.
   */
  unavailableReason?: string
}

const NO_PARAMETERS: ModelParameterSupport = {
  reasoning: [],
  reasoningWire: 'none',
  sampling: [],
  temperatureMax: 1,
}

/**
 * What each transport will actually take.
 *
 * `temperature` and `top_p` are the only two that are universal. The rest split
 * by lineage rather than by vendor quality: `top_k` and `min_p` are truncation
 * cutoffs from the open-weights world, carried by every OpenAI-*compatible*
 * server (vLLM, llama.cpp, LM Studio) and by OpenRouter, but not parameters
 * OpenAI itself defines — sending them to `api.openai.com` is a 400.
 * `presence_penalty` is the mirror image: an OpenAI parameter with no Anthropic
 * equivalent. Anthropic's own addition is `top_k`, which its newest models
 * dropped alongside the other sampling controls.
 */
const OPENAI_COMPATIBLE_SAMPLING: readonly SamplingField[] = SAMPLING_FIELDS
const OPENAI_SAMPLING: readonly SamplingField[] = ['temperature', 'topP', 'presencePenalty']
const ANTHROPIC_SAMPLING: readonly SamplingField[] = ['temperature', 'topP', 'topK']
/** All a route we cannot identify is safe to be offered. */
const UNIVERSAL_SAMPLING: readonly SamplingField[] = ['temperature', 'topP']

/** Namespaces that hand the whole turn to something owning its own settings. */
const AGENT_NAMESPACES: ReadonlySet<ModelNamespace> = new Set(['acp', 'remote-agent', 'pack-model'])

/**
 * Claude families that removed `temperature` / `top_p` (a 400, not a no-op) and
 * accept the full `low`–`max` effort ladder. Prefix-matched so dated snapshots
 * and aggregator suffixes resolve too.
 */
const CLAUDE_EFFORT_NO_SAMPLING = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-mythos-5',
  'claude-mythos-preview',
] as const

/** Claude families with `effort` *and* sampling, whose ladder has no `xhigh`. */
const CLAUDE_EFFORT_WITH_SAMPLING = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-opus-4-5',
] as const

/**
 * Thinking is always on for these — an explicit `thinking: { type: 'disabled' }`
 * is rejected — so `off` is not offered.
 */
const CLAUDE_THINKING_ALWAYS_ON = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-mythos-preview',
] as const

/** OpenAI families that take `reasoning_effort` and reject non-default sampling. */
const OPENAI_REASONING_PREFIXES = ['gpt-5', 'o1', 'o3', 'o4'] as const

const FULL_EFFORT_LADDER: readonly ReasoningLevel[] = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]
const CAPPED_EFFORT_LADDER: readonly ReasoningLevel[] = ['off', 'low', 'medium', 'high', 'max']
const BUDGET_LADDER: readonly ReasoningLevel[] = ['off', 'low', 'medium', 'high']
const OPENAI_LADDER: readonly ReasoningLevel[] = ['minimal', 'low', 'medium', 'high']
const OPENAI_COMPATIBLE_LADDER: readonly ReasoningLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

function matchesFamily(modelId: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => modelId.startsWith(prefix))
}

function claudeSupport(modelId: string): ModelParameterSupport {
  const withoutOff = (ladder: readonly ReasoningLevel[]): readonly ReasoningLevel[] =>
    matchesFamily(modelId, CLAUDE_THINKING_ALWAYS_ON)
      ? ladder.filter((level) => level !== 'off')
      : ladder
  if (matchesFamily(modelId, CLAUDE_EFFORT_NO_SAMPLING)) {
    return {
      reasoning: withoutOff(FULL_EFFORT_LADDER),
      reasoningWire: 'anthropic-effort',
      sampling: [],
      temperatureMax: 1,
    }
  }
  if (matchesFamily(modelId, CLAUDE_EFFORT_WITH_SAMPLING)) {
    return {
      reasoning: CAPPED_EFFORT_LADDER,
      reasoningWire: 'anthropic-effort',
      sampling: ANTHROPIC_SAMPLING,
      temperatureMax: 1,
    }
  }
  // Everything older: no `effort` parameter (it errors), so reasoning is a
  // thinking budget derived from the model's own max output tokens.
  return {
    reasoning: BUDGET_LADDER,
    reasoningWire: 'anthropic-budget',
    sampling: ANTHROPIC_SAMPLING,
    temperatureMax: 1,
  }
}

function openAiSupport(modelId: string): ModelParameterSupport {
  if (matchesFamily(modelId, OPENAI_REASONING_PREFIXES)) {
    return {
      reasoning: OPENAI_LADDER,
      reasoningWire: 'openai-effort',
      sampling: [],
      temperatureMax: 2,
    }
  }
  return { reasoning: [], reasoningWire: 'none', sampling: OPENAI_SAMPLING, temperatureMax: 2 }
}

/**
 * Which parameters `model` accepts, and how they reach it.
 *
 * Takes a stored model selection (`claude-opus-5`, `openrouter:deepseek/…`,
 * `lmstudio:…`), not a bare id — the namespace decides the transport, and the
 * transport decides the wire field.
 */
export function modelParameterSupport(model: string): ModelParameterSupport {
  const selection = parseModelSelection(model)
  if (AGENT_NAMESPACES.has(selection.namespace)) {
    return {
      ...NO_PARAMETERS,
      unavailableReason:
        'This selection runs the whole turn in its own agent, which owns these settings.',
    }
  }
  if (selection.namespace === 'auto') {
    return {
      ...NO_PARAMETERS,
      unavailableReason:
        'This is a rule that picks a model per chat. Parameters follow the model it picks, so pin one to tune it.',
    }
  }
  if (selection.namespace === 'cloud') {
    if (selection.modelId.startsWith('claude')) return claudeSupport(selection.modelId)
    if (selection.modelId.startsWith('gpt')) return openAiSupport(selection.modelId)
    // An unrecognised bare id is routed by whichever key is configured, so we
    // cannot say what it takes. Offer sampling only — the safe intersection.
    return { reasoning: [], reasoningWire: 'none', sampling: UNIVERSAL_SAMPLING, temperatureMax: 2 }
  }
  // OpenAI-compatible transports (OpenRouter, LM Studio, extra providers). The
  // request shape is fixed; which levels the upstream model honours is not.
  return {
    reasoning: OPENAI_COMPATIBLE_LADDER,
    reasoningWire: selection.namespace === 'openrouter' ? 'openrouter' : 'openai-effort',
    sampling: OPENAI_COMPATIBLE_SAMPLING,
    temperatureMax: 2,
    upstreamDecides: true,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function roundToStep(value: number): number {
  // Two decimals: enough for the values vendors actually publish (top_p 0.95,
  // temperature 0.7) without carrying float noise onto the wire.
  return Math.round(value * 100) / 100
}

/**
 * Accepted range for each knob, and how to round a typed value into it.
 *
 * `temperature`'s ceiling is the one that varies by family, so it is read from
 * {@link ModelParameterSupport.temperatureMax} instead of from here. The others
 * are properties of the parameter rather than of the model: a `top_k` is a count
 * of candidate tokens on every server that implements it, and a
 * `presence_penalty` runs −2…2 wherever it exists.
 */
export interface SamplingBounds {
  min: number
  max: number
  /** A whole-number count rather than a probability or a weight. */
  integer?: boolean
  /** The value that means "leave this off", where the parameter has one. */
  neutral?: number
}

export const SAMPLING_BOUNDS: Readonly<Record<SamplingField, SamplingBounds>> = {
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1, neutral: 1 },
  // Upper bound is generous rather than principled: servers differ, and 0
  // (llama.cpp) or -1 (vLLM) both mean "consider everything".
  topK: { min: 0, max: 500, integer: true, neutral: 0 },
  minP: { min: 0, max: 1, neutral: 0 },
  presencePenalty: { min: -2, max: 2, neutral: 0 },
  // 1 is the identity here, not 0 — the value divides the logits of tokens
  // already seen, so 0 would be a hard ban rather than no penalty.
  repetitionPenalty: { min: 0, max: 2, neutral: 1 },
}

function sanitizeSampling(
  field: SamplingField,
  value: unknown,
  temperatureMax: number,
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const bounds = SAMPLING_BOUNDS[field]
  const max = field === 'temperature' ? temperatureMax : bounds.max
  const clamped = clamp(value, bounds.min, max)
  return bounds.integer ? Math.round(clamped) : roundToStep(clamped)
}

/**
 * Drop anything `model` will not accept and clamp what it will.
 *
 * Stored parameters outlive the selection they were saved against: a user tunes
 * temperature on a 4.6 model, later pins Opus 5, and that same stored value is
 * now a 400. Sanitizing on read means a stale entry degrades to the provider
 * default instead of failing the turn.
 */
export function sanitizeModelParameters(
  params: ModelParameters,
  model: string,
  support: ModelParameterSupport = modelParameterSupport(model),
): ModelParameters {
  const sanitized: ModelParameters = {}
  if (params.reasoning !== undefined && support.reasoning.includes(params.reasoning)) {
    sanitized.reasoning = params.reasoning
  }
  for (const field of support.sampling) {
    const value = sanitizeSampling(field, params[field], support.temperatureMax)
    if (value !== undefined) sanitized[field] = value
  }
  return sanitized
}

/**
 * Lower `level` to `ceiling` when it is deeper, keeping the model's own
 * vocabulary. Ordered by {@link REASONING_LEVELS}, which runs cheapest-first.
 *
 * Used by roles whose job description is "cheap and fast": a user who set their
 * chat model to `max` meant it for the work, not for generating a thread title
 * with the same model.
 */
export function clampReasoning(
  level: ReasoningLevel | undefined,
  ceiling: ReasoningLevel,
): ReasoningLevel | undefined {
  if (level === undefined) return undefined
  return REASONING_LEVELS.indexOf(level) <= REASONING_LEVELS.indexOf(ceiling) ? level : ceiling
}

// ── Sourced recommendations ──────────────────────────────────────────────────

/**
 * A vendor's published parameter recipe for a model.
 *
 * Deliberately *offered*, never applied: recipes are scenario-specific (DeepSeek
 * publishes one `top_p` for agentic use and another for everything else), an
 * aggregator may route the same id to an endpoint the recipe was not written
 * for, and a value we applied on the user's behalf is invisible when it turns
 * out to be wrong. Filling the visible fields keeps the choice theirs and the
 * result on screen.
 */
export interface ModelParameterRecommendation {
  /** What the recipe is tuned for, shown on the affordance. */
  label: string
  /** Where it comes from, so a user can check it rather than trust us. */
  source: string
  params: ModelParameters
  /**
   * An output ceiling the card publishes for its deeper reasoning levels.
   *
   * Unlike {@link params} this one *is* applied automatically, because it is not
   * a preference: a model told to reason at `max` that then runs into a low
   * default output cap gets truncated mid-answer, and nothing on screen would
   * explain why. There is also nothing for the user to weigh — a ceiling is
   * permission to use tokens, not a decision to spend them, so raising it costs
   * nothing on a turn that ends sooner.
   */
  outputCeiling?: RecommendedOutputCeiling
}

export interface RecommendedOutputCeiling {
  /** Maximum output tokens to allow, as published. */
  tokens: number
  /** The shallowest reasoning level the ceiling is published for. */
  fromReasoning: ReasoningLevel
}

/**
 * Published recipes, matched by model-id prefix.
 *
 * This table is hand-maintained and dates: an entry is only as good as the
 * version it was read against, so each carries its source. Add a row when a
 * vendor publishes one — never infer a recipe from a benchmark table or from
 * another model in the same family.
 */
const RECOMMENDATIONS: ReadonlyArray<ModelParameterRecommendation & { match: string }> = [
  {
    match: 'deepseek-v4-flash',
    label: 'DeepSeek’s agentic recipe',
    source: 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731',
    // The model card's agentic profile: max reasoning effort, temperature 1.0,
    // and the tighter top_p it specifies for agentic scenarios (0.95) rather
    // than the 1.0 it recommends otherwise. Copse runs a tool loop, so the
    // agentic column is the applicable one.
    params: { reasoning: 'max', temperature: 1, topP: 0.95 },
    // "For the `high` and `max` reasoning effort levels, we recommend a maximum
    // output length of 384K tokens" — the deep levels spend the output budget on
    // reasoning, so the card's own recipe needs the room it asks for.
    outputCeiling: { tokens: 384_000, fromReasoning: 'high' },
  },
  {
    match: 'qwen3.6-35b-a3b',
    label: 'Qwen’s thinking-mode recipe',
    source: 'https://huggingface.co/Qwen/Qwen3.6-35B-A3B',
    // The card publishes three sets, split by mode and task rather than by
    // "agentic": thinking/general, thinking/precise-coding (temperature 0.6,
    // presence_penalty 0), and instruct/non-thinking. This is the first.
    //
    // Choosing between the coding set and the general one is the only judgement
    // in this row, and the card settles it: its own agentic evals — SWE-Bench on
    // a "bash + file-edit tools" scaffold, Terminal-Bench 2.0 under an agent
    // harness — ran temp=1.0, top_p=0.95, top_k=20, which is the general set.
    // The coding set is for single-shot generation (its example is WebDev), not
    // for a tool loop. Copse is the former shape.
    //
    // No `reasoning`: the model thinks by default and exposes no effort ladder,
    // so the recipe is about sampling only. Sending an effort would be us
    // inventing a control the card never names.
    params: {
      temperature: 1,
      topP: 0.95,
      topK: 20,
      minP: 0,
      presencePenalty: 1.5,
      repetitionPenalty: 1,
    },
    // Deliberately no `outputCeiling`. The card does recommend an output length
    // (32,768 for most queries, 81,920 for hard problems), but as adequacy
    // advice, not tied to a reasoning depth — and a ceiling we send is a cap
    // that can truncate. Nothing constrains output today; leaving it that way is
    // the safer reading of "sufficient space".
  },
]

function findRecommendation(
  model: string,
): (ModelParameterRecommendation & { match: string }) | undefined {
  const selection = parseModelSelection(model)
  if (AGENT_NAMESPACES.has(selection.namespace) || selection.namespace === 'auto') return undefined
  // Case-insensitive because the same weights are addressed differently by each
  // route: Hugging Face keeps the vendor's capitalisation (`Qwen/Qwen3.6-35B-A3B`)
  // while OpenRouter and LM Studio lowercase it. A recipe that applied to one
  // spelling and not the other would look like a bug in the picker.
  const id = selection.modelId.toLowerCase()
  return RECOMMENDATIONS.find((entry) => id.includes(entry.match))
}

/**
 * The published output ceiling for `model` at the reasoning level in `params`,
 * or `undefined` when we hold none or the level is shallower than the one it was
 * published for.
 *
 * Sent as `max_tokens`, which is a *permission* rather than a request: a turn
 * that finishes in 2K tokens still costs 2K. So the only real risk is an
 * endpoint that will not accept the number — an aggregator may serve the same
 * model with a lower cap than the vendor's own API — and the OpenAI transport
 * drops the field and retries once when that happens.
 */
export function recommendedOutputCeiling(
  model: string,
  params: ModelParameters,
): number | undefined {
  const ceiling = findRecommendation(model)?.outputCeiling
  if (!ceiling || params.reasoning === undefined) return undefined
  const level = REASONING_LEVELS.indexOf(params.reasoning)
  return level >= REASONING_LEVELS.indexOf(ceiling.fromReasoning) ? ceiling.tokens : undefined
}

/**
 * The published recipe for `model`, sanitized against what it accepts, or
 * `null` when we hold none. Sanitizing here means a recipe never offers a value
 * the selected route would reject — an aggregator that cannot take one of the
 * three simply offers the rest.
 */
export function recommendedModelParameters(model: string): ModelParameterRecommendation | null {
  const match = findRecommendation(model)
  if (!match) return null
  const params = sanitizeModelParameters(match.params, model)
  if (isEmptyModelParameters(params)) return null
  return {
    label: match.label,
    source: match.source,
    params,
    ...(match.outputCeiling ? { outputCeiling: match.outputCeiling } : {}),
  }
}

// ── Wire mapping ─────────────────────────────────────────────────────────────

/** Thinking budgets for the pre-`effort` Claude models, in output tokens. */
const BUDGET_TOKENS: Partial<Record<ReasoningLevel, number>> = {
  low: 4_096,
  medium: 16_384,
  high: 32_768,
}

/** The API floor for `thinking.budget_tokens`. */
const MIN_BUDGET_TOKENS = 1_024

/**
 * Headroom left for the answer itself: the budget must be strictly less than
 * `max_tokens`, and a budget that consumed all of it would leave the model no
 * room to reply.
 */
const BUDGET_HEADROOM_TOKENS = 1_024

/**
 * Resolve a thinking budget for the pre-`effort` Claude models, or `null` when
 * the model's output cap leaves no room to think and answer.
 */
export function anthropicThinkingBudget(level: ReasoningLevel, maxTokens: number): number | null {
  const requested = BUDGET_TOKENS[level]
  if (requested === undefined) return null
  const ceiling = maxTokens - BUDGET_HEADROOM_TOKENS
  if (ceiling < MIN_BUDGET_TOKENS) return null
  return Math.min(requested, ceiling)
}

/** Anthropic `thinking` / `output_config` / sampling fields for a request body. */
export interface AnthropicParameterFields {
  thinking?:
    { type: 'adaptive' } | { type: 'disabled' } | { type: 'enabled'; budget_tokens: number }
  output_config?: { effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
  temperature?: number
  top_p?: number
  top_k?: number
}

const ANTHROPIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

function anthropicEffort(level: ReasoningLevel): (typeof ANTHROPIC_EFFORTS)[number] | null {
  return ANTHROPIC_EFFORTS.find((effort) => effort === level) ?? null
}

/**
 * Map sanitized parameters onto Anthropic request fields.
 *
 * `off` disables thinking rather than naming an effort; a named level sets
 * `output_config.effort` *and* asks for adaptive thinking, because effort tunes
 * how much the model thinks and is inert when thinking is off. On the older
 * models the same level becomes a token budget instead.
 */
export function anthropicParameterFields(
  params: ModelParameters,
  model: string,
  maxTokens: number = anthropicMaxOutputTokens(model),
  support: ModelParameterSupport = modelParameterSupport(model),
): AnthropicParameterFields {
  const fields: AnthropicParameterFields = {}
  const { reasoning } = params
  if (reasoning === 'off') {
    fields.thinking = { type: 'disabled' }
  } else if (reasoning !== undefined && support.reasoningWire === 'anthropic-effort') {
    const effort = anthropicEffort(reasoning)
    if (effort) {
      fields.thinking = { type: 'adaptive' }
      fields.output_config = { effort }
    }
  } else if (reasoning !== undefined && support.reasoningWire === 'anthropic-budget') {
    const budget = anthropicThinkingBudget(reasoning, maxTokens)
    if (budget !== null) fields.thinking = { type: 'enabled', budget_tokens: budget }
  }
  if (params.temperature !== undefined) fields.temperature = params.temperature
  if (params.topP !== undefined) fields.top_p = params.topP
  if (params.topK !== undefined) fields.top_k = params.topK
  return fields
}

/** OpenAI-shaped `reasoning_effort` / sampling fields for a request body. */
export interface OpenAIParameterFields {
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  temperature?: number
  top_p?: number
  top_k?: number
  min_p?: number
  presence_penalty?: number
  repetition_penalty?: number
}

/** The numeric subset of the request shape — every key a sampling knob maps to. */
type OpenAISamplingKey = Exclude<keyof OpenAIParameterFields, 'reasoning_effort'>

/** Each knob's OpenAI-shaped request key. */
const OPENAI_SAMPLING_KEYS: Readonly<Record<SamplingField, OpenAISamplingKey>> = {
  temperature: 'temperature',
  topP: 'top_p',
  topK: 'top_k',
  minP: 'min_p',
  presencePenalty: 'presence_penalty',
  repetitionPenalty: 'repetition_penalty',
}

/**
 * Map sanitized parameters onto OpenAI Chat Completions fields. `off` sends
 * `reasoning_effort: 'none'` — the value OpenAI-compatible servers use to turn
 * a hybrid model's reasoning off; `minimal` is its own level, not a synonym.
 *
 * The output ceiling is deliberately not here: it is resolved once per provider
 * from the model plus the *whole* parameter set (see
 * {@link recommendedOutputCeiling}) and carried as its own transport option, so
 * the one code path that sends it is also the one that can drop it on rejection.
 */
export function openAiParameterFields(params: ModelParameters): OpenAIParameterFields {
  const fields: OpenAIParameterFields = {}
  if (params.reasoning !== undefined) {
    fields.reasoning_effort = params.reasoning === 'off' ? 'none' : params.reasoning
  }
  for (const field of SAMPLING_FIELDS) {
    const value = params[field]
    if (value !== undefined) fields[OPENAI_SAMPLING_KEYS[field]] = value
  }
  return fields
}

/** Responses-API fields: same values, but reasoning is a nested object there. */
export interface ResponsesParameterFields {
  reasoning?: { effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
  temperature?: number
  top_p?: number
}

/**
 * {@link openAiParameterFields} in the Responses API's request shape.
 *
 * Only the two sampling knobs that API defines: it has no penalties, and the
 * open-weights cutoffs (`top_k`, `min_p`) were never OpenAI parameters. Picked
 * field by field rather than spread, so a knob added above cannot silently
 * reach a request shape with no place for it.
 */
export function responsesParameterFields(params: ModelParameters): ResponsesParameterFields {
  const { reasoning_effort: effort, temperature, top_p: topP } = openAiParameterFields(params)
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { top_p: topP }),
    ...(effort === undefined ? {} : { reasoning: { effort } }),
  }
}

/**
 * OpenRouter's unified reasoning field. It normalises `reasoning` across
 * upstream vendors, so it is preferred over the raw `reasoning_effort` alias —
 * and it is the only one of the two that can express "off"
 * (`{ enabled: false }`).
 */
export function openRouterReasoningBody(
  params: ModelParameters,
): { reasoning: { effort: ReasoningLevel } | { enabled: false } } | Record<string, never> {
  const { reasoning } = params
  if (reasoning === undefined) return {}
  if (reasoning === 'off') return { reasoning: { enabled: false } }
  return { reasoning: { effort: reasoning } }
}

// ── Persistence ──────────────────────────────────────────────────────────────

function decodeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Decode one persisted entry, ignoring anything unrecognised. */
export function decodeModelParameters(value: unknown): ModelParameters {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const record: Record<string, unknown> = { ...value }
  const params: ModelParameters = {}
  if (isReasoningLevel(record['reasoning'])) params.reasoning = record['reasoning']
  for (const field of SAMPLING_FIELDS) {
    const value = decodeNumber(record[field])
    if (value !== undefined) params[field] = value
  }
  return params
}

/**
 * Decode the whole `modelParameters` setting: model selection → parameters.
 * Hand-rolled rather than schema-validated because both the renderer (which has
 * no zod) and the main process read it, and an unreadable entry should mean
 * "no parameters for that model", never a thrown turn.
 */
export function decodeModelParametersMap(value: unknown): Record<string, ModelParameters> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, ModelParameters> = {}
  for (const [model, entry] of Object.entries(value)) {
    if (!model) continue
    const params = decodeModelParameters(entry)
    if (!isEmptyModelParameters(params)) out[model] = params
  }
  return out
}

/** The parameters stored for `model`, sanitized against what it accepts. */
export function resolveModelParameters(stored: unknown, model: string): ModelParameters {
  const entry = decodeModelParametersMap(stored)[model]
  return entry ? sanitizeModelParameters(entry, model) : {}
}
