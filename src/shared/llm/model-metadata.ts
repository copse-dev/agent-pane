/** Input context windows for cloud chat models (history trimming). */
export const CLOUD_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-sonnet-4-6': 200_000,
  'claude-opus-4-8': 200_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
}

/** Anthropic API max_tokens (output budget) per model id. */
export const ANTHROPIC_MAX_OUTPUT_TOKENS: Record<string, number> = {
  'claude-sonnet-4-6': 64_000,
  'claude-opus-4-8': 64_000,
}

const DEFAULT_ANTHROPIC_MAX_OUTPUT = 8192

export function anthropicMaxOutputTokens(model: string): number {
  return ANTHROPIC_MAX_OUTPUT_TOKENS[model] ?? DEFAULT_ANTHROPIC_MAX_OUTPUT
}
