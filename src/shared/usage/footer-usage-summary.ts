import { formatThreadUsageCost } from '@shared/llm/estimate-cost.ts'
import type { ContextBreakdown, ContextSnapshot, Message, ThreadUsage } from '@shared/types'

const CHARS_PER_TOKEN = 4

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

function formatTokenThousands(total: number, estimated: boolean): string {
  const value = total ? `${(total / 1000).toFixed(1)}k tokens` : '0 tokens'
  return estimated ? `~${value}` : value
}

/** Footer usage button label (compact or expanded with optional cost). */
export function formatFooterUsageSummary(
  display: FooterUsageDisplay,
  opts: {
    costVisible: boolean
    model: string
    measuredUsage: ThreadUsage
    extra?: import('@shared/llm/estimate-cost.ts').ExtraPricing
  },
): string {
  const { inputTokens, outputTokens, estimated } = display
  const total = inputTokens + outputTokens

  if (opts.costVisible) {
    const inLabel = estimated ? `~${inputTokens}` : `${inputTokens}`
    const outLabel = estimated ? `~${outputTokens}` : `${outputTokens}`
    const cost = estimated
      ? 'est.'
      : formatThreadUsageCost(opts.measuredUsage, opts.model, opts.extra)
    return cost ? `${inLabel} in / ${outLabel} out · ${cost}` : `${inLabel} in / ${outLabel} out`
  }

  return formatTokenThousands(total, estimated)
}
