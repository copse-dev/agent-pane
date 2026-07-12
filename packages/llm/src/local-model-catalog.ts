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
import { LOCAL_MODEL_BENCHMARKS } from './local-model-benchmarks.generated.ts'
import { estimateQuantizedScore } from './quant-penalty.ts'

/** Benchmark axes we track. Keys are referenced by `AgentRole.wants`. */
export type Benchmark =
  | 'swe-bench' // SWE-bench Verified — agentic bug-fix on real repos
  | 'humaneval-plus' // HumanEval+ — function synthesis with extra tests
  | 'livecodebench' // LiveCodeBench — contamination-resistant coding
  | 'aider-polyglot' // Aider polyglot — multi-language diff-edit benchmark
  | 'aider-edit' // Aider edit — Python Exercism edit benchmark (has GGUF runs)
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
  'aider-edit',
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
  /**
   * Bits per weight the score was measured at (16 = full precision). Lets the
   * runtime decide whether to adjust a full-precision number down to the model's
   * actual quant. Absent for scores of unknown precision.
   */
  measuredBitsPerWeight?: number
  /**
   * True when `value` is a full-precision score adjusted down by the modelled
   * quantization penalty (see `quant-penalty.ts`) rather than a direct quantized
   * measurement. The UI must surface estimates as estimates.
   */
  estimated?: boolean
  /** Derivation for an estimate (e.g. the penalty applied), for the "why" tooltip. */
  basis?: string
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
 * plan doc. Inline `benchmarks` are the curated/editorial layer; measured scores
 * are merged in from the sync-generated file below (see {@link LOCAL_MODEL_CATALOG}).
 */
const BASE_CATALOG: readonly LocalModelCapability[] = [
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

/**
 * The catalog, with measured benchmark scores from `sync:local-models` merged
 * over the inline editorial entries. Synced scores win where both exist.
 */
export const LOCAL_MODEL_CATALOG: readonly LocalModelCapability[] = BASE_CATALOG.map((m) => {
  const synced = LOCAL_MODEL_BENCHMARKS[m.id] as
    Partial<Record<Benchmark, BenchmarkScore>> | undefined
  if (!synced) return m
  return { ...m, benchmarks: { ...m.benchmarks, ...synced } }
})

const MODEL_BY_ID: ReadonlyMap<string, LocalModelCapability> = new Map(
  LOCAL_MODEL_CATALOG.map((m) => [m.id, m]),
)

export function getLocalModelCapability(id: string): LocalModelCapability | null {
  return MODEL_BY_ID.get(id) ?? null
}

// Approximate effective bits per weight per K-quant family, for adjusting a
// full-precision score down to how the model actually runs.
const QUANT_BITS_PER_WEIGHT: Record<string, number> = {
  q8: 8,
  q6: 6.6,
  q5: 5.5,
  q4: 4.5,
  q3: 3.4,
  q2: 2.6,
}

/** Effective bits per weight for a quant label like "Q4_K_M" (default 4.5). */
export function bitsPerWeightForQuant(quant: string): number {
  const m = /q(\d)/i.exec(quant)
  const key = m ? `q${m[1] ?? ''}` : ''
  return QUANT_BITS_PER_WEIGHT[key] ?? 4.5
}

/**
 * The benchmark score to show for a model *as it runs locally*: the measured
 * score when it was measured at or below the model's quant, otherwise the
 * full-precision measurement adjusted down by the modelled quant penalty (flagged
 * `estimated`). Null when the benchmark is unknown for the model.
 */
export function localBenchmarkScore(
  model: LocalModelCapability,
  benchmark: Benchmark,
): BenchmarkScore | null {
  const measured = model.benchmarks[benchmark]
  if (!measured) return null
  const targetBpw = bitsPerWeightForQuant(model.quant)
  if (measured.measuredBitsPerWeight === undefined || measured.measuredBitsPerWeight <= targetBpw) {
    return measured
  }
  const est = estimateQuantizedScore(measured.value, {
    bitsPerWeight: targetBpw,
    paramsB: model.paramsB,
  })
  return {
    value: est.value,
    source: measured.source,
    asOf: measured.asOf,
    measuredBitsPerWeight: targetBpw,
    estimated: true,
    basis: est.basis,
  }
}

/**
 * Compact capability hint for the model picker (e.g. "coder · refactor · test-gen"),
 * or null when the id isn't in the catalog. Lets the dropdown classify a local
 * model by the roles it suits without a guess for unknown models.
 */
export function localModelRoleHint(id: string): string | null {
  const cap = getLocalModelCapability(id)
  if (!cap || cap.bestForRoles.length === 0) return null
  return cap.bestForRoles.slice(0, 3).join(' · ')
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

/**
 * Roles a fresh local install should cover out of the box — the main coding
 * model plus the two lightweight helpers the app already ships defaults for
 * (see `preferred-models.ts`). Ordered as presented to the user.
 */
export const CORE_LOCAL_ROLES: readonly AgentRoleId[] = ['coder', 'small-tasks', 'safety']

export interface RecommendedAssignment {
  role: AgentRoleId
  model: LocalModelCapability
}

/**
 * The "good default" local setup: the top budget-fitting recommendation for each
 * core role. Powers both the default advice and a future one-click "download the
 * recommended set" (each `model.id` feeds the existing `lmstudio:download` IPC).
 * A role with no budget-fitting candidate is simply omitted rather than forcing
 * an over-budget pick. Deterministic — no I/O, no clock.
 */
export function recommendedLocalSetup(opts: RecommendOptions = {}): RecommendedAssignment[] {
  const out: RecommendedAssignment[] = []
  for (const role of CORE_LOCAL_ROLES) {
    const top = recommendLocalModelsForRole(role, opts)[0]
    if (top) out.push({ role, model: top })
  }
  return out
}

export interface HardwareClass {
  id: string
  /** Human label for the picker/onboarding. */
  label: string
  /** Approximate unified memory / VRAM this class targets, in GB. */
  memoryGb: number
  /**
   * Largest model download we recommend for the class, in GB. Held well below
   * `memoryGb` (≈65–70%) so there's headroom for the KV cache, the OS, and the
   * app — a model that just fits in memory still thrashes once context grows.
   */
  maxDownloadGb: number
}

/**
 * A few hardware tiers so recommendations fit the user's machine instead of a
 * single 64 GB reference. `maxDownloadGb` is the budget passed to the recommender
 * (footprint at 4-bit ≈ on-disk size). Ordered smallest first.
 */
export const HARDWARE_CLASSES: readonly HardwareClass[] = [
  { id: 'compact', label: 'Compact (≈8 GB)', memoryGb: 8, maxDownloadGb: 6 },
  { id: 'standard', label: 'Standard (≈16 GB)', memoryGb: 16, maxDownloadGb: 11 },
  { id: 'plus', label: 'Plus (≈24–32 GB)', memoryGb: 32, maxDownloadGb: 22 },
  { id: 'workstation', label: 'Workstation (≈48–64 GB)', memoryGb: 64, maxDownloadGb: 45 },
  { id: 'server', label: 'Server (96 GB+)', memoryGb: 96, maxDownloadGb: Infinity },
]

export function getHardwareClass(id: string): HardwareClass | null {
  return HARDWARE_CLASSES.find((c) => c.id === id) ?? null
}

/** The recommended local setup sized for a hardware class (see {@link recommendedLocalSetup}). */
export function recommendedSetupForClass(classId: string): RecommendedAssignment[] {
  const hw = getHardwareClass(classId)
  if (!hw) return []
  return recommendedLocalSetup({ maxDownloadGb: hw.maxDownloadGb })
}
