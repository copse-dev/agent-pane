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

/**
 * Guide for making a local model's context length survive restarts (LM Studio
 * resets it to a small default on reboot). Surfaced in the settings advisory and
 * from the startup warning. Points at the doc on the default branch so the link
 * is stable once merged.
 */
export const LM_STUDIO_CONTEXT_GUIDE_URL =
  'https://github.com/jonathanKingston/agent-pane/blob/main/docs/lm-studio-context-persistence.md'

/** True when a known context window is below the recommended minimum. */
export function isContextWindowLow(
  contextWindow: number | null | undefined,
  minimum: number = RECOMMENDED_MIN_CONTEXT_WINDOW,
): boolean {
  return typeof contextWindow === 'number' && contextWindow > 0 && contextWindow < minimum
}

/** The largest known (positive) context window in a list, or `null` if none are known. */
export function bestKnownContextWindow(
  windows: readonly (number | null | undefined)[],
): number | null {
  let best = 0
  for (const w of windows) {
    if (typeof w === 'number' && w > best) best = w
  }
  return best > 0 ? best : null
}

/**
 * True when at least one candidate model reaches the recommended minimum context
 * window — i.e. a usable chat default is available. Unknown windows (null) don't
 * count as decent, matching {@link isContextWindowLow}'s "no false alarms" rule.
 */
export function hasDecentContextWindow(
  windows: readonly (number | null | undefined)[],
  minimum: number = RECOMMENDED_MIN_CONTEXT_WINDOW,
): boolean {
  const best = bestKnownContextWindow(windows)
  return best !== null && best >= minimum
}

/**
 * Plain-text warning for when no available chat model reaches the recommended
 * minimum context window. `bestAvailable` is the largest window we could find
 * (null when nothing reported one, e.g. a local server that doesn't expose it).
 */
export function noDecentChatDefaultAdvice(
  bestAvailable: number | null,
  minimum: number = RECOMMENDED_MIN_CONTEXT_WINDOW,
): string {
  const floor = `the recommended ${formatTokens(minimum)}`
  const current =
    typeof bestAvailable === 'number' && bestAvailable > 0
      ? `the largest available loads only ${formatTokens(bestAvailable)} of context`
      : `no available model reports a usable context window`
  return (
    `No chat model with a usable context window is available — ${current}, below ${floor}. ` +
    `Agent runs will trim history quickly. Load a local model with a larger “Context Length” ` +
    `in LM Studio (and save it as the default so it survives a restart), or add a cloud API key.`
  )
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
