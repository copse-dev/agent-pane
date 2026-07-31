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
  /**
   * The footer's chat model. When `measured.byModel` has a per-model breakdown,
   * usage narrows to this model's own turns — excluding subagent spend (explore,
   * post-turn review, local todo workers) folded into the thread total, so the
   * default display reads as "what the parent conversation spent" rather than
   * everything the turn spawned. Threads with no breakdown fall back to the
   * thread-wide total.
   */
  model: string
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
  const { measured } = input
  if (measured.inputTokens || measured.outputTokens) {
    const { byModel } = measured
    const hasBreakdown = !!byModel && Object.keys(byModel).length > 0
    const { inputTokens, outputTokens } = hasBreakdown
      ? (byModel[input.model] ?? { inputTokens: 0, outputTokens: 0 })
      : measured
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
  const value = `${formatTokenCount(total)} tokens`
  return estimated ? `~${value}` : value
}

/** Footer usage button label (compact or expanded with optional cost). */
export function formatFooterUsageSummary(
  display: FooterUsageDisplay,
  opts: {
    costVisible: boolean
    model: string
    measuredUsage: ThreadUsage
    extra?: import('@copse/llm/estimate-cost.ts').ExtraPricing
  },
): string {
  const { inputTokens, outputTokens, estimated } = display
  const total = inputTokens + outputTokens

  if (opts.costVisible) {
    const inLabel = estimated ? `~${String(inputTokens)}` : String(inputTokens)
    const outLabel = estimated ? `~${String(outputTokens)}` : String(outputTokens)
    const cost = estimated
      ? 'est.'
      : formatThreadUsageCost(opts.measuredUsage, opts.model, opts.extra)
    return cost ? `${inLabel} in / ${outLabel} out · ${cost}` : `${inLabel} in / ${outLabel} out`
  }

  return formatTokenThousands(total, estimated)
}
