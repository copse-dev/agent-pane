import { resolveModelFamily } from '@copse/llm/model-families.ts'

/**
 * Which base-prompt variant a model gets. `default` is the model-agnostic prompt
 * every provider shipped with; a family gets its own profile only when a
 * measured ablation (`pnpm run eval:doctrine`, see
 * docs/plans/doctrine-compliance-evals.md) showed a section helps or hurts it.
 */
export const PROMPT_PROFILES = ['default', 'gpt'] as const

export type PromptProfile = (typeof PROMPT_PROFILES)[number]

/**
 * Canonical family keys (from the shared table in `model-families.ts`) of the
 * GPT reasoning models the `gpt` profile is for. A family missing here, or a new
 * one the table learns about, stays on `default` until someone measures it.
 */
const GPT_PROFILE_FAMILIES: ReadonlySet<string> = new Set(['gpt-5', 'gpt-6-astra', 'gpt-6.1-sol'])

/**
 * The single lookup from a stored model selection to a prompt profile. No model
 * (headless checks, composer estimates), local and agent namespaces, and every
 * unmeasured family resolve to `default`, so the prompt stays byte-stable unless
 * a profile is earned.
 */
export function resolvePromptProfile(model: string | undefined): PromptProfile {
  if (model == null) return 'default'
  const { family } = resolveModelFamily(model)
  return family !== null && GPT_PROFILE_FAMILIES.has(family) ? 'gpt' : 'default'
}
