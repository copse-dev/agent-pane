/**
 * Advice for chat models with a small context window.
 *
 * LM Studio (and some other local servers) default new models to a tiny context
 * length — often 4K tokens — which is unsuitable as a main chat default: agent
 * loops, tool output, and file reads overflow it almost immediately. When we know
 * a model's context window at setup time we surface a non-blocking advisory rather
 * than silently letting history get over-trimmed.
 */

/**
 * Recommended minimum context window (tokens) for a model used as the main chat
 * default. Below this, agentic workflows trim history aggressively and degrade.
 * 16K is a pragmatic floor: large enough for a few tool round-trips, small enough
 * that most local models can reach it once the load context length is raised.
 */
export const RECOMMENDED_MIN_CONTEXT_WINDOW = 16_384

/** Link to a VRAM/context sizing tool, surfaced alongside the advisory. */
export const VRAM_CALCULATOR_URL = 'https://apxml.com/tools/vram-calculator'

/** True when a known context window is below the recommended minimum. */
export function isContextWindowLow(
  contextWindow: number | null | undefined,
  minimum: number = RECOMMENDED_MIN_CONTEXT_WINDOW,
): boolean {
  return typeof contextWindow === 'number' && contextWindow > 0 && contextWindow < minimum
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000 && tokens % 1000 === 0) return `${String(tokens / 1000)}K`
  if (tokens >= 1000) return `${String(Math.round(tokens / 1000))}K`
  return String(tokens)
}

/**
 * Plain-text advisory for a low-context model, or `null` when the context window
 * is unknown or already at/above the recommended minimum. Mentions how to raise
 * it in LM Studio; callers can append the VRAM calculator link.
 */
export function lowContextAdvice(
  contextWindow: number | null | undefined,
  opts: { modelId?: string; minimum?: number } = {},
): string | null {
  const minimum = opts.minimum ?? RECOMMENDED_MIN_CONTEXT_WINDOW
  if (!isContextWindowLow(contextWindow, minimum)) return null
  const subject = opts.modelId ? `“${opts.modelId}”` : 'This model'
  return (
    `${subject} loads with only ${formatTokens(contextWindow as number)} tokens of context ` +
    `(below the recommended ${formatTokens(minimum)} for a main chat model). ` +
    `Agent runs will trim history quickly. In LM Studio, raise the model’s ` +
    `“Context Length” when loading it (Developer tab → model settings), then reload.`
  )
}
