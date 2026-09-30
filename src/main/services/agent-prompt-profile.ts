import { modelFamily } from '@copse/llm/model-catalog.ts'

/**
 * Which base-prompt variant a model gets. `default` is the model-agnostic prompt
 * every provider shipped with; a family gets its own profile only when a
 * measured ablation (`pnpm run eval:doctrine`, see
 * docs/plans/doctrine-compliance-evals.md) showed a section helps or hurts it.
 */
export const PROMPT_PROFILES = ['default', 'gpt'] as const

export type PromptProfile = (typeof PROMPT_PROFILES)[number]

/**
 * The single lookup from a stored model selection to a prompt profile. No model
 * (headless checks, composer estimates) and every unmeasured family resolve to
 * `default`, so the prompt stays byte-stable unless a profile is earned.
 */
export function resolvePromptProfile(model: string | undefined): PromptProfile {
  if (model == null) return 'default'
  return modelFamily(model) === 'gpt' ? 'gpt' : 'default'
}
