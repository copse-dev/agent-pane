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
   * Tokens spent by subagents, already folded into the thread's raw measured
   * usage upstream (`subagent-usage.ts`) and folded back out of the fields
   * above. Present only when a subagent reported usage on a measured (not
   * estimated) display — the footer's "Subagents" row draws on this.
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
 * These tokens are already inside the parent thread's totals — the main process
 * folds them in after the run (`subagent-usage.ts`) — so this is a "how much of
 * the total was delegated work" view, not an addition to it.
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
 * Prefer measured provider usage; fall back to context/output estimates when
 * zero. Recorded subagent usage is already folded into `input.measured`
 * upstream, so it is subtracted back out here (see `sumSubagentUsage`) rather
 * than left inflating the headline. Other background work without a persisted
 * subagent session remains in the total.
 */
export function resolveFooterUsage(input: FooterUsageInput): FooterUsageDisplay | null {
  const { inputTokens, outputTokens } = input.measured
  if (inputTokens || outputTokens) {
    const subagents = sumSubagentUsage(input.messages)
    return {
      inputTokens: Math.max(0, inputTokens - subagents.inputTokens),
      outputTokens: Math.max(0, outputTokens - subagents.outputTokens),
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
