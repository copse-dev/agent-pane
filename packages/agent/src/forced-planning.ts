// Forced-planning policy — "if the model running this turn measures below a
// capability threshold, make it write a plan before it acts".
//
// The premise: a frontier model can hold a multi-step task in its head and
// recover from a wrong turn; a smaller or heavily-quantized one drifts, forgets
// the second half of the request, and declares victory early. An explicit,
// externalised plan (the `update_todos` list) is the cheapest known fix — it
// gives the weaker model a checklist to re-read every step instead of relying on
// recall. This module decides *when* that plan is mandatory and *what* to say.
//
// Owned by `@copse/agent` so the first-party hook can use it without importing
// the host (execution-guidance rule 4). Pure: no I/O, no settings read — the
// resolved config is passed in (the hook reads pack settings via its context)
// and the capability number comes from the shared `@copse/llm` lookup.
//
// **Two scales, two thresholds.** `resolveModelIntellect` tags every value with
// the ruler it sits on: the canonical Artificial Analysis Intelligence Index
// (frontier ≈ 55–60, Haiku 4.5 = 24) or the crystallised Copse composite (a
// weighted mean of 0–100 pass-rate benchmarks, used for local weights that
// Artificial Analysis never measured). Those two are explicitly incomparable, so
// this module holds one threshold per scale and never converts between them.
import type { TodoItem } from './wire-types.ts'
import {
  describeIntellectScale,
  resolveModelIntellect,
  type IntellectScale,
  type ResolvedIntellect,
} from '@copse/llm/intellect-lookup.ts'

/**
 * Stable id of the pack that owns this policy. Declared here rather than in
 * `packs/forced-planning-pack.ts` because the turn-start hook needs it to read
 * its own pack settings, and the pack module imports that hook — putting the id
 * in the pack would make the two modules a cycle.
 */
export const FORCED_PLANNING_PACK_ID = 'copse.forced-planning'

/**
 * The plan tool the todos-tool variant of the steering names. Deliberately a
 * literal rather than an import of `TODOS_TOOL_NAME`: `packs/todos-pack.ts`
 * imports the turn-start hooks that consume this module, so importing it back
 * would close an import cycle. `forced-planning-pack.test.ts` asserts the two
 * strings stay equal, which is what keeps the duplication honest.
 */
export const PLAN_TOOL_NAME = 'update_todos'

/**
 * Default canonical-scale threshold. Sits between Haiku-4.5-class models (24)
 * and the mid-tier open weights that clear 44 — i.e. "plan when the model is
 * meaningfully below the models that can improvise reliably". Users retune it
 * per workspace from Settings → Packs.
 */
export const DEFAULT_CANONICAL_INTELLECT_THRESHOLD = 40

/**
 * Default composite-scale threshold. The composite is a weighted mean of 0–100
 * pass-rate benchmarks, so it runs much higher than the canonical index for the
 * same model; 60 is the rough dividing line between the small local weights and
 * the strong 30B-class coders in the catalog.
 */
export const DEFAULT_COMPOSITE_INTELLECT_THRESHOLD = 60

/**
 * What to do when the running model has no sourced measurement on either scale.
 * `skip` (the default) is conservative: an unmeasured model is just as likely to
 * be a brand-new frontier release as an obscure small one, and silently changing
 * every prompt on a guess is worse than doing nothing. `plan` suits a workspace
 * that runs mostly unlisted local weights, where "unmeasured" reliably means
 * "small".
 */
export type UnmeasuredModelPolicy = 'plan' | 'skip'

/** Resolved configuration for one decision (the hook maps pack settings onto this). */
export interface ForcedPlanningConfig {
  /** Force a plan below this value on the canonical Intelligence Index scale. */
  canonicalThreshold: number
  /** Force a plan below this value on the Copse composite scale. */
  compositeThreshold: number
  /** Behavior when the model carries no sourced measurement at all. */
  unmeasured: UnmeasuredModelPolicy
}

/** The config used when nothing is persisted (matches the manifest defaults). */
export const DEFAULT_FORCED_PLANNING_CONFIG: ForcedPlanningConfig = {
  canonicalThreshold: DEFAULT_CANONICAL_INTELLECT_THRESHOLD,
  compositeThreshold: DEFAULT_COMPOSITE_INTELLECT_THRESHOLD,
  unmeasured: 'skip',
}

/** Pack-setting keys, shared by the manifest schema and the hook that reads them. */
export const CANONICAL_THRESHOLD_SETTING = 'canonicalIntellectThreshold'
export const COMPOSITE_THRESHOLD_SETTING = 'compositeIntellectThreshold'
export const UNMEASURED_MODELS_SETTING = 'unmeasuredModels'

/** Allowed values for the `unmeasuredModels` enum field (manifest + coercion). */
export const UNMEASURED_MODEL_POLICIES: readonly UnmeasuredModelPolicy[] = ['skip', 'plan']

/**
 * Coerce a persisted setting into a usable threshold. Settings cross IPC as
 * `unknown` and a number field can arrive as a string (or as `NaN` from an
 * emptied number input), so anything that is not a finite, non-negative number
 * falls back to the default rather than silently disabling the policy.
 */
function readThreshold(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return value
}

function readUnmeasuredPolicy(
  raw: unknown,
  fallback: UnmeasuredModelPolicy,
): UnmeasuredModelPolicy {
  return UNMEASURED_MODEL_POLICIES.find((policy) => policy === raw) ?? fallback
}

/**
 * Project the pack's persisted settings onto a {@link ForcedPlanningConfig}.
 * `read` is the pack-scoped reader the hook receives from its context; an absent
 * reader (or an absent value) yields the manifest defaults, so the policy
 * behaves identically in pure package tests and on a fresh install.
 */
export function resolveForcedPlanningConfig(read?: (key: string) => unknown): ForcedPlanningConfig {
  if (!read) return DEFAULT_FORCED_PLANNING_CONFIG
  return {
    canonicalThreshold: readThreshold(
      read(CANONICAL_THRESHOLD_SETTING),
      DEFAULT_CANONICAL_INTELLECT_THRESHOLD,
    ),
    compositeThreshold: readThreshold(
      read(COMPOSITE_THRESHOLD_SETTING),
      DEFAULT_COMPOSITE_INTELLECT_THRESHOLD,
    ),
    unmeasured: readUnmeasuredPolicy(
      read(UNMEASURED_MODELS_SETTING),
      DEFAULT_FORCED_PLANNING_CONFIG.unmeasured,
    ),
  }
}

/** The turn facts the decision reads. */
export interface ForcedPlanningInput {
  /** The resolved model id running this turn (picker form is fine — it is resolved). */
  model?: string | undefined
  /** Raw user text for the turn (steering is decided on unredacted text). */
  userText: string
  /** Todos carried over from prior turns — a live plan means one already exists. */
  priorTodos: readonly TodoItem[]
  /** Whether `update_todos` is actually in this turn's tool list. */
  todosToolAvailable: boolean
}

/** Why a turn was (or was not) forced to plan — for the hook-run spine and tests. */
export interface ForcedPlanningDecision {
  /** The steering block to inject into the turn's system message. */
  prompt: string
  /** Short machine-readable reason, e.g. `canonical 24 < 40`. */
  reason: string
  /** The resolved capability score, or null when the model is unmeasured. */
  intellect: ResolvedIntellect | null
}

/**
 * Below this many characters a request is treated as too small to plan —
 * "yes", "continue", "now run the tests". Deliberately a *lower* bar than
 * `shouldSteerTodos`: the entire point of this pack is that a weaker model needs
 * a plan for work a frontier model would one-shot, so the keyword heuristics
 * that gate the ordinary todo nudge would defeat it.
 */
export const MIN_FORCED_PLAN_TEXT_LENGTH = 40

/** Todos that still represent outstanding work (a plan the model is mid-way through). */
function hasLivePlan(todos: readonly TodoItem[]): boolean {
  return todos.some((todo) => todo.status === 'pending' || todo.status === 'in_progress')
}

/** The threshold that applies to a resolved value's scale. */
function thresholdForScale(scale: IntellectScale, config: ForcedPlanningConfig): number {
  return scale === 'canonical' ? config.canonicalThreshold : config.compositeThreshold
}

/**
 * The mandatory-plan block for a turn where `update_todos` is on the tool list.
 *
 * Deliberately says nothing about *why* the plan is required — the model is not
 * told it scored below a threshold. That framing is unactionable for the model
 * and risks it narrating its own limitations to the user; the measured reason
 * travels in {@link ForcedPlanningDecision.reason} instead, where the hook-run
 * record and Settings can show it.
 */
export const FORCED_TODO_PLAN_PROMPT = `## Plan before acting (required for this turn)

This workspace requires an explicit, tracked plan for a request of this size.

1. Before any other tool call, call \`update_todos\` once with 3–7 concrete steps. Each step names the file, command, or check it covers — not "investigate" or "make changes".
2. Keep exactly one item \`in_progress\` at a time. Mark it \`completed\` before starting the next one.
3. Re-read the plan before each step and follow the order you set. When you discover work the plan missed, call \`update_todos\` again to add it rather than doing it silently.
4. Do not report the task finished while any item is still \`pending\` or \`in_progress\` — either complete it or mark it \`cancelled\` and say why.`

/**
 * The fallback for a turn where `update_todos` is not offered (the todos pack is
 * disabled, or read-only mode dropped the tool). The plan is still mandatory —
 * it just lives in the reply instead of the plan panel, which is what makes this
 * pack useful independently of the todos pack.
 */
export const FORCED_WRITTEN_PLAN_PROMPT = `## Plan before acting (required for this turn)

This workspace requires an explicit plan for a request of this size, and no plan tool is available this turn.

1. Before any other tool call, write a numbered plan of 3–7 concrete steps. Each step names the file, command, or check it covers — not "investigate" or "make changes".
2. Work the steps in the order you wrote them, restating which step you are on as you go.
3. When you discover work the plan missed, restate the updated plan rather than doing it silently.
4. Before reporting the task finished, restate the plan and confirm every step is done or explicitly dropped with a reason.`

/**
 * Decide whether this turn must open with a plan, and with what steering text.
 * Null means abstain — the turn is assembled exactly as it would have been
 * without this pack.
 *
 * Abstains when: no model id is known; the request is too short to be worth
 * planning; a plan is already live from a prior turn (the todo-pin hook carries
 * it); the model has no sourced measurement and the config says `skip`; or the
 * model measures at or above the threshold for its scale.
 *
 * `resolve` defaults to the shared `@copse/llm` lookup and exists as an
 * injection seam: it lets the tests exercise both scales (the composite branch
 * has no shipped catalog entry today — every measured local weight also carries
 * an Intelligence Index number) without pinning the policy to catalog data that
 * the next `sync:intellect` run may change.
 */
export function decideForcedPlanning(
  input: ForcedPlanningInput,
  config: ForcedPlanningConfig = DEFAULT_FORCED_PLANNING_CONFIG,
  resolve: (model: string) => ResolvedIntellect | null = resolveModelIntellect,
): ForcedPlanningDecision | null {
  const model = input.model?.trim()
  if (!model) return null
  if (input.userText.trim().length < MIN_FORCED_PLAN_TEXT_LENGTH) return null
  if (hasLivePlan(input.priorTodos)) return null

  const prompt = input.todosToolAvailable ? FORCED_TODO_PLAN_PROMPT : FORCED_WRITTEN_PLAN_PROMPT
  const intellect = resolve(model)
  if (!intellect) {
    if (config.unmeasured !== 'plan') return null
    return { prompt, reason: `${model} has no sourced intellect measurement`, intellect: null }
  }

  const threshold = thresholdForScale(intellect.scale, config)
  if (intellect.value >= threshold) return null
  return {
    prompt,
    reason: `${model} scores ${intellect.estimated ? '~' : ''}${String(intellect.value)} on ${describeIntellectScale(
      intellect.scale,
    )}, below the ${String(threshold)} threshold`,
    intellect,
  }
}
