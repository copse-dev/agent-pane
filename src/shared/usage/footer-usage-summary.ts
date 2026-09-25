import { formatThreadUsageCost } from '@copse/llm/estimate-cost.ts'
import type {
  ContextBreakdown,
  ContextSnapshot,
  Message,
  ThreadUsage,
  ToolCall,
} from '@shared/types'
import { CHARS_PER_TOKEN } from '@copse/agent/token-estimate.ts'
import { formatTokenCount } from './format-usage-summary.ts'

export interface FooterUsageDisplay {
  /** Thread tokens with recorded tool-call subagent runs folded out. */
  inputTokens: number
  outputTokens: number
  /** True when provider-reported usage is unavailable and counts are approximated. */
  estimated: boolean
  /**
   * Tokens subagent sessions reported (see `sumSubagentUsage`). Present only
   * when a subagent reported usage on a measured (not estimated) display — the
   * footer's "Subagents" row draws on this.
   */
  subagentInputTokens?: number
  subagentOutputTokens?: number
}

export interface SubagentUsageTotals {
  /** Subagent runs that reported usage; one still running contributes nothing yet. */
  runs: number
  inputTokens: number
  outputTokens: number
}

function collectSubagentUsage(toolCalls: ToolCall[], totals: SubagentUsageTotals): void {
  for (const toolCall of toolCalls) {
    const session = toolCall.subagent
    if (!session) continue
    if (session.usage) {
      totals.runs += 1
      totals.inputTokens += session.usage.inputTokens
      totals.outputTokens += session.usage.outputTokens
    }
    // A nested subagent's tokens are recorded on its own session, never folded
    // into its parent's (run-subagent.ts does not forward `usage` upstream), so
    // recursing here sums the tree rather than double-counting it.
    for (const message of session.messages) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- persisted/legacy messages may predate the toolCalls field
      collectSubagentUsage(message.toolCalls ?? [], totals)
    }
  }
}

/**
 * Total tokens spent by subagents in a thread, at every nesting depth.
 *
 * A session records its usage as soon as it finishes, but the main process
 * only folds it into the thread total once the parent loop completes
 * (`subagent-usage.ts`), and not at all when that loop fails. So this is how
 * much work was delegated, not how much of the thread total it accounts for;
 * `ThreadUsage.subagentInputTokens` records that.
 */
export function sumSubagentUsage(messages: Message[]): SubagentUsageTotals {
  const totals: SubagentUsageTotals = { runs: 0, inputTokens: 0, outputTokens: 0 }
  for (const message of messages) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- persisted/legacy messages may predate the toolCalls field
    collectSubagentUsage(message.toolCalls ?? [], totals)
  }
  return totals
}

export interface FooterUsageInput {
  measured: ThreadUsage
  running: boolean
  messages: Message[]
  contextSnapshot?: ContextSnapshot | undefined
  breakdown?: ContextBreakdown | null | undefined
}

/** Rough assistant + subagent text size (~4 chars/token), for footer output fallback. */
export function estimateAssistantOutputTokens(messages: Message[]): number {
  let chars = 0
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    chars += message.content.length
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- persisted/legacy messages may predate the toolCalls field
    for (const toolCall of message.toolCalls ?? []) {
      for (const subMessage of toolCall.subagent?.messages ?? []) {
        if (subMessage.role === 'assistant') chars += subMessage.content.length
      }
    }
  }
  return Math.round(chars / CHARS_PER_TOKEN)
}

/**
 * The subagent share of `measured` — only what was actually folded into it.
 * Usage recorded before the share was tracked falls back to the finished
 * sessions, which is what a completed run folded in.
 */
function foldedSubagentShare(
  measured: ThreadUsage,
  sessions: SubagentUsageTotals,
): { inputTokens: number; outputTokens: number } {
  if (measured.subagentInputTokens !== undefined || measured.subagentOutputTokens !== undefined) {
    return {
      inputTokens: measured.subagentInputTokens ?? 0,
      outputTokens: measured.subagentOutputTokens ?? 0,
    }
  }
  return sessions
}

/**
 * Prefer measured provider usage; fall back to context/output estimates when
 * zero. The subagent share folded into `input.measured` is subtracted back out
 * here rather than left inflating the headline; a subagent whose usage was
 * never folded in (a failed loop, or a run still in progress) is not
 * subtracted. Other background work without a persisted subagent session
 * remains in the total.
 */
export function resolveFooterUsage(input: FooterUsageInput): FooterUsageDisplay | null {
  const { inputTokens, outputTokens } = input.measured
  if (inputTokens || outputTokens) {
    const subagents = sumSubagentUsage(input.messages)
    const folded = foldedSubagentShare(input.measured, subagents)
    return {
      inputTokens: Math.max(0, inputTokens - folded.inputTokens),
      outputTokens: Math.max(0, outputTokens - folded.outputTokens),
      estimated: false,
      ...(subagents.runs > 0
        ? {
            subagentInputTokens: subagents.inputTokens,
            subagentOutputTokens: subagents.outputTokens,
          }
        : {}),
    }
  }

  const estimatedOutput = estimateAssistantOutputTokens(input.messages)
  const estimatedInput =
    input.contextSnapshot?.conversationTokens ??
    (input.running ? undefined : input.breakdown?.totalTokens)

  const total = (estimatedInput ?? 0) + estimatedOutput
  if (!total && !input.running) return null

  return {
    inputTokens: estimatedInput ?? 0,
    outputTokens: estimatedOutput,
    estimated: true,
  }
}

/** Footer usage label — total tokens only; the breakdown lives in the hover tooltip. */
export function formatFooterUsageSummary(display: FooterUsageDisplay): string {
  const value = `${formatTokenCount(display.inputTokens + display.outputTokens)} tokens`
  return display.estimated ? `~${value}` : value
}

/**
 * One-line total + in/out/cost summary. Used where a popover cannot follow the
 * counter — the compact footer hides the counter and tucks usage into the
 * context wheel's native title. It leads with the same total the counter shows,
 * because in that layout the wheel is all that is left of it.
 */
export function formatFooterUsageDetail(
  display: FooterUsageDisplay,
  opts: {
    model: string
    measuredUsage: ThreadUsage
    pricing?: import('@copse/llm/model-pricing.ts').ModelPricingMap
  },
): string {
  const { inputTokens, outputTokens, estimated } = display
  const approx = estimated ? '~' : ''
  const split = `${approx}${formatTokenCount(inputTokens)} in / ${approx}${formatTokenCount(outputTokens)} out`
  const rawCost = estimated
    ? 'est.'
    : formatThreadUsageCost(opts.measuredUsage, opts.model, opts.pricing)
  const cost =
    !estimated && rawCost && display.subagentInputTokens !== undefined
      ? `whole-thread cost ${rawCost}`
      : rawCost
  const parts = [formatFooterUsageSummary(display), split, ...(cost ? [cost] : [])]
  return `Usage: ${parts.join(' · ')}`
}
