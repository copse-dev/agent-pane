// The local-model capability catalog: the *capability* axis of model selection —
// "what is a model good at", measured objectively. Sibling to `model-catalog.ts`
// (cloud pricing + context, synced from LiteLLM); this one carries sizing and
// benchmark scores for local weights (LM Studio / Ollama / llama.cpp).
//
// Phase 0 of `docs/plans/model-roles-and-defaults.md`: pure data + helpers, not
// yet wired into routing.
//
// SOURCING RULE — benchmark numbers are facts, not vibes. We do NOT hardcode
// guessed scores. Each score is stored with its `source` + `asOf`; until a real,
// cited value is synced the score is simply absent (and the UI shows "—"). A
// `sync:local-models` step (analogous to `sync:models`) will populate them. The
// sizing fields (`params`, `quant`, `downloadGb`) are approximate and used only
// for hardware-budget filtering and onboarding copy — the same latitude the
// existing `downloadGb` estimates in `preferred-models.ts` already take. Catalog
// ids are data, not literals in logic, because the app already ships
// forward-looking ids (e.g. `qwen/qwen3.6-35b-a3b`).

import { AGENT_ROLES, type AgentRoleId } from './agent-roles.ts'

/** Benchmark axes we track. Keys are referenced by `AgentRole.wants`. */
export type Benchmark =
  | 'swe-bench' // SWE-bench Verified — agentic bug-fix on real repos
  | 'humaneval-plus' // HumanEval+ — function synthesis with extra tests
  | 'livecodebench' // LiveCodeBench — contamination-resistant coding
  | 'aider-polyglot' // Aider polyglot — multi-language edit benchmark
  | 'multipl-e' // MultiPL-E — HumanEval translated to many languages
  | 'gpqa' // GPQA — graduate-level reasoning
  | 'mmlu-pro' // MMLU-Pro — harder MMLU
  | 'tau-bench' // τ-bench — agentic tool use
  | 'arena' // Arena / user-preference ranking

export const BENCHMARKS: readonly Benchmark[] = [
  'swe-bench',
  'humaneval-plus',
  'livecodebench',
  'aider-polyglot',
  'multipl-e',
  'gpqa',
  'mmlu-pro',
  'tau-bench',
  'arena',
]

export interface BenchmarkScore {
  /** The score, in the benchmark's own units (usually a 0–100 percentage). */
  value: number
  /** Where the number came from (paper, leaderboard, own eval). Required. */
  source: string
  /** ISO date the score was recorded, e.g. "2025-03". Required. */
  asOf: string
}

export interface LocalModelCapability {
  /** Weight identifier (LM Studio / HF style). Data, never matched in logic. */
  id: string
  /** Human label for the picker. */
  label: string
  /** Approximate total parameters, in billions. */
  paramsB: number
  /** Active parameters per token for MoE models, in billions (omit for dense). */
  activeParamsB?: number
  /** Quantisation the sizing below assumes (the common local default). */
  quant: string
  /** Approximate download size at {@link quant}, in GB. */
  downloadGb: number
  /** Native/max context window in tokens, when known. */
  contextWindow?: number
  /** Roles this model is a good fit for (the capability→role hint). */
  bestForRoles: readonly AgentRoleId[]
  /**
   * Sourced benchmark scores. Absent keys mean "not yet measured", NOT zero —
   * ranking treats them as unknown, never as a failing score.
   */
  benchmarks: Partial<Record<Benchmark, BenchmarkScore>>
}

/**
 * Seed catalog. Includes the ids the app already ships (see
 * `preferred-models.ts`) plus the 64 GB / 4-bit reference shortlist from the
 * plan doc. Benchmarks start empty by design — see the sourcing rule above.
 */
export const LOCAL_MODEL_CATALOG: readonly LocalModelCapability[] = [
  {
    id: 'qwen/qwen3.6-35b-a3b',
    label: 'Qwen3 35B A3B',
    paramsB: 35,
    activeParamsB: 3,
    quant: 'Q4_K_M',
    downloadGb: 22,
    bestForRoles: ['coder', 'reviewer', 'planner', 'debugger'],
    benchmarks: {},
  },
  {
    id: 'qwen/qwen2.5-coder-32b',
    label: 'Qwen2.5-Coder 32B',
    paramsB: 32,
    quant: 'Q4_K_M',
    downloadGb: 19,
    bestForRoles: ['coder', 'refactor', 'test-gen'],
    benchmarks: {},
  },
  {
    id: 'deepseek/deepseek-coder-v2-lite',
    label: 'DeepSeek-Coder V2 Lite',
    paramsB: 16,
    activeParamsB: 2.4,
    quant: 'Q4_K_M',
    downloadGb: 10,
    bestForRoles: ['reviewer', 'coder', 'test-gen'],
    benchmarks: {},
  },
  {
    id: 'mistralai/mistral-small-24b',
    label: 'Mistral Small 24B',
    paramsB: 24,
    quant: 'Q4_K_M',
    downloadGb: 14,
    bestForRoles: ['tool-use', 'small-tasks', 'research'],
    benchmarks: {},
  },
  {
    id: 'google/gemma-3-12b',
    label: 'Gemma 3 12B',
    paramsB: 12,
    quant: 'Q4_K_M',
    downloadGb: 8,
    bestForRoles: ['docs', 'small-tasks'],
    benchmarks: {},
  },
  {
    id: 'microsoft/phi-4',
    label: 'Phi-4 (~14B)',
    paramsB: 14,
    quant: 'Q4_K_M',
    downloadGb: 9,
    bestForRoles: ['judge', 'tool-use', 'security-auditor'],
    benchmarks: {},
  },
  {
    id: 'google/gemma-4-e4b',
    label: 'Gemma 4 E4B',
    paramsB: 4,
    quant: 'Q4_K_M',
    downloadGb: 4,
    bestForRoles: ['small-tasks', 'docs'],
    benchmarks: {},
  },
  {
    id: 'qwen/qwen3-4b-2507',
    label: 'Qwen3 4B',
    paramsB: 4,
    quant: 'Q4_K_M',
    downloadGb: 2.5,
    bestForRoles: ['safety', 'small-tasks'],
    benchmarks: {},
  },
]

const MODEL_BY_ID: ReadonlyMap<string, LocalModelCapability> = new Map(
  LOCAL_MODEL_CATALOG.map((m) => [m.id, m]),
)

export function getLocalModelCapability(id: string): LocalModelCapability | null {
  return MODEL_BY_ID.get(id) ?? null
}

export interface RecommendOptions {
  /** Only consider models whose download fits this budget (GB). */
  maxDownloadGb?: number
}

/**
 * Rank the catalog's models for a role: keep those that advertise the role and
 * fit the hardware budget, then order by how well their *sourced* scores cover
 * the role's `wants` (most-important benchmark first). Models with no sourced
 * scores rank below those with them but are still returned — a suitable model is
 * never dropped just because its benchmarks aren't in yet. Ties fall back to the
 * catalog's declared order, so the result is deterministic (no I/O, no clock).
 */
export function recommendLocalModelsForRole(
  roleId: AgentRoleId,
  opts: RecommendOptions = {},
): LocalModelCapability[] {
  const role = AGENT_ROLES.find((r) => r.id === roleId)
  if (!role) return []
  const budget = opts.maxDownloadGb ?? Infinity

  const candidates = LOCAL_MODEL_CATALOG.map((model, index) => ({ model, index })).filter(
    ({ model }) => model.bestForRoles.includes(roleId) && model.downloadGb <= budget,
  )

  const scoreFor = (model: LocalModelCapability): number => {
    // Weight earlier `wants` more; only sourced scores contribute.
    let total = 0
    role.wants.forEach((bench, i) => {
      const s = model.benchmarks[bench]
      if (s) total += s.value * (role.wants.length - i)
    })
    return total
  }

  return candidates
    .sort((a, b) => {
      const diff = scoreFor(b.model) - scoreFor(a.model)
      return diff !== 0 ? diff : a.index - b.index
    })
    .map(({ model }) => model)
}
