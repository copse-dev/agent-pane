// Host-side resolution of a dynamic model selection (`auto:…`) into a concrete,
// routable model id.
//
// The vocabulary lives in `@copse/llm/dynamic-model.ts` and the picking rules in
// `@copse/llm/dynamic-model-pick.ts`; this module is the part that cannot be
// pure — it needs the live candidate pool (which providers have usable keys,
// which models LM Studio has loaded, how much of the plan window is left) and
// the user's role assignments.
//
// Every feature that stores a model choice now stores a selector, so this is the
// single expansion point: `resolveAgentChatModel` calls it for chat turns and
// automations, and the advisor / comparison / orchestration read sites call it
// for their own models.

import {
  isDynamicModel,
  parseDynamicModel,
  type DynamicModelSelector,
} from '@copse/llm/dynamic-model.ts'
import { pickDynamicModel } from '@copse/llm/dynamic-model-pick.ts'
import type { FrontierPoint } from '@copse/llm/pareto-frontier.ts'
import { FALLBACK_APP_CHAT_MODEL } from '@shared/lm-studio-defaults.ts'
import { routableFrontierPoints, toRoutableModelId } from './best-value-model.ts'
import { getRoleModels } from './role-models.ts'

export interface ResolveDynamicModelOptions {
  /**
   * Model ids this resolution should avoid returning — how the model-comparison
   * run keeps its two reviewers and its judge distinct when all three are
   * dynamic. A preference, not a constraint: when excluding leaves nothing
   * routable we return the colliding model rather than nothing at all, because
   * a duplicate reviewer degrades the feature while an empty one breaks it.
   */
  exclude?: readonly string[]
  /** Candidate pool, when the caller already loaded it (resolves several selectors). */
  pool?: readonly FrontierPoint[]
}

/** A role assignment may itself be dynamic; bound the indirection. */
const MAX_ROLE_INDIRECTION = 4

/**
 * Stand-ins used when `COPSE_PANEL_MOCK_LLM` is on. The mock provider answers to
 * any id, so these only need to be routable-looking and *different from each
 * other* — enough for a run that resolves several selectors to behave like the
 * real thing rather than collapsing onto one model.
 */
const MOCK_MODELS: readonly string[] = [
  FALLBACK_APP_CHAT_MODEL,
  'claude-sonnet-4-6',
  'claude-opus-4-8',
]

/**
 * Expand a stored model selection. Pinned ids (and `auto:` values this build
 * does not recognise) pass through untouched, so a downgrade or a hand-edited
 * settings file still routes to whatever the user actually wrote.
 */
export async function resolveDynamicModelId(
  value: string,
  opts: ResolveDynamicModelOptions = {},
): Promise<string> {
  if (!isDynamicModel(value)) return value

  // Mock LLM accepts any id — skip the catalog/plan fetches so e2e and agent
  // loops don't wait on the network to learn what they already know. Exclusions
  // are still honoured: collapsing every selector onto one id would make the
  // comparison harness's distinct reviewers indistinguishable under the mock,
  // which is precisely the behaviour those runs exist to exercise.
  if (process.env['COPSE_PANEL_MOCK_LLM'] === '1') {
    const excluded = new Set(opts.exclude ?? [])
    return MOCK_MODELS.find((model) => !excluded.has(model)) ?? FALLBACK_APP_CHAT_MODEL
  }

  let selector = parseDynamicModel(value)
  if (!selector) return value

  // Roles are indirection through the user's own assignments, resolved before
  // the candidate pool is ever consulted: an assigned model wins outright.
  for (let hop = 0; selector.kind === 'role' && hop < MAX_ROLE_INDIRECTION; hop++) {
    const assigned = getRoleModels()[selector.role]?.trim()
    if (!assigned) break
    if (!isDynamicModel(assigned)) return assigned
    const next: DynamicModelSelector | null = parseDynamicModel(assigned)
    if (!next) return assigned
    selector = next
  }
  // An unassigned role (or a cycle of them) falls back to best value — the same
  // rule the app uses when it has no other information about which model to use.
  if (selector.kind === 'role') selector = { kind: 'best-value' }

  const pool = opts.pool ?? (await routableFrontierPoints())
  const excluded = new Set(opts.exclude ?? [])
  const remaining = excluded.size
    ? pool.filter((point) => !excluded.has(toRoutableModelId(point)))
    : pool
  const picked = pickDynamicModel(selector, remaining.length > 0 ? remaining : pool)
  return picked ? toRoutableModelId(picked) : FALLBACK_APP_CHAT_MODEL
}

/**
 * Resolve several selections against ONE candidate pool, each avoiding the
 * models the earlier ones took. Order matters: the first entry gets the
 * unconstrained pick, later entries settle for the best of what is left.
 *
 * This is what makes "the model-comparison models are never the same" true by
 * construction — resolving A, B, and the judge one at a time against a shared
 * pool cannot produce a duplicate unless the pool has run out of models.
 */
export async function resolveDistinctDynamicModelIds(
  values: readonly string[],
  opts: { pool?: readonly FrontierPoint[] } = {},
): Promise<string[]> {
  // Load the pool only when something actually needs it: three pinned ids should
  // not cost an LM Studio probe, an OpenRouter fetch, and a plan-usage read.
  const pool =
    opts.pool ??
    (values.some((value) => isDynamicModel(value)) ? await routableFrontierPoints() : undefined)
  const taken: string[] = []
  const resolved: string[] = []
  for (const value of values) {
    // A pinned id ignores `exclude` (resolution returns it verbatim), so the
    // user's explicit choice always wins; it still joins `taken` so the dynamic
    // choices *after* it pick something else.
    const model = await resolveDynamicModelId(value, {
      ...(pool ? { pool } : {}),
      exclude: taken,
    })
    resolved.push(model)
    taken.push(model)
  }
  return resolved
}
