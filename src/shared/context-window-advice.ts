/**
 * Advice about context windows: models whose window is too small to be a useful
 * default, and threads that no longer fit the model chosen for them.
 *
 * LM Studio (and some other local servers) default new models to a tiny context
 * length — often 4K tokens — which is unsuitable as a main chat default: agent
 * loops, tool output, and file reads overflow it almost immediately. Settings
 * carries the setup-time advisory ({@link lowContextAdvice}); the composer
 * carries the per-thread one ({@link contextFitAdvice}), which is where a model
 * choice actually meets a conversation of a known size.
 */
import { expectNumber } from '@shared/unknown-value.ts'

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
 * resets it to a small default on reboot). Surfaced in the settings advisory.
 * Points at the doc on the default branch so the link is stable once merged.
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
 * Feeds the `/checkup` diagnostics report.
 */
export function hasDecentContextWindow(
  windows: readonly (number | null | undefined)[],
  minimum: number = RECOMMENDED_MIN_CONTEXT_WINDOW,
): boolean {
  const best = bestKnownContextWindow(windows)
  return best !== null && best >= minimum
}

/**
 * Fraction of a model's context window at or above which the current thread is
 * "close to full". Below this a run has room for a few more turns; at or above
 * it, history trimming is imminent (and at 1.0 the prompt no longer fits at all).
 */
export const CONTEXT_NEARLY_FULL_RATIO = 0.9

/** `over` — the next prompt exceeds the window; `near` — it almost does. */
export type ContextFitLevel = 'over' | 'near'

export interface ContextFitAdvice {
  level: ContextFitLevel
  /** Share of the window the next prompt needs (1.2 means 20% over). */
  fillRatio: number
  /** Plain-text explanation, including how to get out of the situation. */
  message: string
}

/**
 * Advice for a thread that no longer fits (or barely fits) the model chosen for
 * it — the message shown when a user picks a model whose context window is too
 * small for the conversation they already have.
 *
 * Returns `null` while the prompt fits comfortably, and whenever the estimate is
 * unusable (no window reported, nothing measured yet) so an unknown never reads
 * as a problem.
 */
export function contextFitAdvice(
  estimate: { totalTokens: number; contextWindow: number } | null | undefined,
  opts: { modelLabel?: string; lmStudioModel?: boolean; nearlyFullRatio?: number } = {},
): ContextFitAdvice | null {
  if (!estimate) return null
  const { totalTokens, contextWindow } = estimate
  if (contextWindow <= 0 || totalTokens <= 0) return null
  const fillRatio = totalTokens / contextWindow
  if (fillRatio < (opts.nearlyFullRatio ?? CONTEXT_NEARLY_FULL_RATIO)) return null

  const subject = opts.modelLabel ? `“${opts.modelLabel}”` : 'the selected model'
  // Two ways out, in the order a user can act on them: swap the model (one click
  // away in the picker beside this message), or make the thread cheaper to send.
  // Local models get a third — their window is a load-time setting, not a limit.
  const remedy =
    `Pick a model with a larger context window, or free up context — remove attachments ` +
    `or start a new thread.` +
    (opts.lmStudioModel === true
      ? ` You can also raise this model’s “Context Length” in LM Studio and reload it.`
      : '')
  const message =
    fillRatio >= 1
      ? `This thread no longer fits ${subject}: the next prompt needs about ` +
        `${formatTokenEstimate(totalTokens)} tokens and its context window holds ` +
        `${formatTokens(contextWindow)}. ${remedy}`
      : `This thread already fills ${String(Math.round(fillRatio * 100))}% of the ` +
        `${formatTokens(contextWindow)} context window on ${subject} ` +
        `(about ${formatTokenEstimate(totalTokens)} tokens), so older messages will be ` +
        `trimmed as it runs. ${remedy}`
  return { level: fillRatio >= 1 ? 'over' : 'near', fillRatio, message }
}

/**
 * How the providers Copse talks to word "your prompt did not fit". They agree on
 * nothing: OpenAI-compatible servers return the `context_length_exceeded` code,
 * Anthropic writes prose about the prompt being too long, and LM Studio forwards
 * its engine's own 500 (`engine protocol predict stream returned an error:
 * {"code":500,"message":"context size has been exceeded.",…}`). Matching all of
 * them in one place keeps every caller — chat error copy, one-shot background
 * prompts — from growing its own partial list.
 */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context[ _-]?length/i,
  /context window/i,
  /context size has been exceeded/i,
  /prompt is too long/i,
  // llama.cpp gives up on the chat template when trimming leaves it no room.
  /tokens to keep from the initial prompt/i,
]

/** True when an error message says the prompt exceeded the model's context. */
export function isContextOverflowMessage(text: string): boolean {
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * Advice for a one-shot background prompt — a roadmap resolution check, a fit
 * check — that the model refused for context. Unlike a chat thread there is no
 * history to trim and nothing the user did wrong, so the message names the task
 * that failed and the two ways out: give the model more context, or send the
 * work to a bigger one.
 */
export function contextOverflowAdvice(opts: {
  /** The task, capitalised for the start of a sentence ("The resolution check"). */
  task: string
  modelLabel?: string
  contextWindow?: number | null
  /** Where the model for this task is chosen, when the user can change it. */
  settingsPath?: string
  /** Local models get the load-time fix too; their window is a setting, not a limit. */
  lmStudioModel?: boolean
}): string {
  const subject = opts.modelLabel ? `“${opts.modelLabel}”` : 'the model'
  const window =
    typeof opts.contextWindow === 'number' && opts.contextWindow > 0
      ? `${formatTokens(opts.contextWindow)} `
      : ''
  const where = opts.settingsPath ? ` under ${opts.settingsPath}` : ''
  const remedy =
    opts.lmStudioModel === true
      ? `In LM Studio, raise the model’s “Context Length” and reload it, or choose a larger model${where}.`
      : `Choose a larger model${where}.`
  return `${opts.task} did not fit ${subject}’s ${window}context window. ${remedy}`
}

/** Round context-window sizes, which are whole thousands in practice ("8K"). */
function formatTokens(tokens: number): string {
  if (tokens >= 1000 && tokens % 1000 === 0) return `${String(tokens / 1000)}K`
  if (tokens >= 1000) return `${String(Math.round(tokens / 1000))}K`
  return String(tokens)
}

/**
 * Measured token counts, which are not round. Keeps one decimal below 100K so a
 * thread sitting just over an 8K window doesn't read as "8K of 8K".
 */
function formatTokenEstimate(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  const thousands = tokens / 1000
  if (Number.isInteger(thousands)) return `${String(thousands)}K`
  return thousands >= 100 ? `${String(Math.round(thousands))}K` : `${thousands.toFixed(1)}K`
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
    `${subject} loads with only ${formatTokens(expectNumber(contextWindow))} tokens of context ` +
    `(below the recommended ${formatTokens(minimum)} for a main chat model). ` +
    `Agent runs will trim history quickly. In LM Studio, raise the model’s ` +
    `“Context Length” when loading it (Developer tab → model settings), then reload.`
  )
}
