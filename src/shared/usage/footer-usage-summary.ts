import { formatThreadUsageCost } from '@copse/llm/estimate-cost.ts'
import type { ContextBreakdown, ContextSnapshot, Message, ThreadUsage } from '@shared/types'
import { CHARS_PER_TOKEN } from '@copse/agent/token-estimate.ts'
import { formatTokenCount } from './format-usage-summary.ts'

export interface FooterUsageDisplay {
  inputTokens: number
  outputTokens: number
  /** True when provider-reported usage is unavailable and counts are approximated. */
  estimated: boolean
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

/** Prefer measured provider usage; fall back to context/output estimates when zero. */
export function resolveFooterUsage(input: FooterUsageInput): FooterUsageDisplay | null {
  const { inputTokens, outputTokens } = input.measured
  if (inputTokens || outputTokens) {
    return { inputTokens, outputTokens, estimated: false }
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
 * One-line in/out/cost summary. Used where a popover cannot follow the counter —
 * the compact footer tucks usage into the context wheel's native title.
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
  const tokens = `${approx}${formatTokenCount(inputTokens)} in / ${approx}${formatTokenCount(outputTokens)} out`
  const cost = estimated
    ? 'est.'
    : formatThreadUsageCost(opts.measuredUsage, opts.model, opts.pricing)
  return cost ? `Usage: ${tokens} · ${cost}` : `Usage: ${tokens}`
}
