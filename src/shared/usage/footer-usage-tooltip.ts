import { costForModelUsage, formatThreadUsageCost, isLocalModel } from '@copse/llm/estimate-cost.ts'
import type { ModelPricingMap } from '@copse/llm/model-pricing.ts'
import type { Message, ModelUsage, ThreadUsage, ToolCall } from '@shared/types'
import type { FooterUsageDisplay } from './footer-usage-summary.ts'
import { formatTokenCount, formatUsd } from './format-usage-summary.ts'

export interface FooterUsageTooltipRow {
  label: string
  value: string
}

export interface FooterUsageTooltipModel {
  /** Headline: total tokens, `~`-prefixed when the counts are estimated. */
  header: string
  /** In/out (plus cache and cost when known) — one row per line. */
  rows: FooterUsageTooltipRow[]
  /**
   * How much of the total came from delegated work; null when no subagent in
   * the thread has reported usage.
   */
  subagentRow: FooterUsageTooltipRow | null
  /** Per-model tokens + cost, only when the thread spans more than one model. */
  modelRows: FooterUsageTooltipRow[]
  /** Why numbers are approximate or a cost is missing; null when neither applies. */
  note: string | null
}

export interface FooterUsageTooltipOptions {
  /** Concrete chat model, used to price usage that carries no per-model breakdown. */
  model: string
  measuredUsage: ThreadUsage
  /** Thread messages, walked for per-subagent usage records. */
  messages: Message[]
  pricing?: ModelPricingMap | undefined
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

function modelRowValue(model: string, usage: ModelUsage, pricing?: ModelPricingMap): string {
  const tokens = `${formatTokenCount(usage.inputTokens)} in / ${formatTokenCount(usage.outputTokens)} out`
  if (isLocalModel(model)) return `${tokens} · free`
  const cost = costForModelUsage(model, usage, pricing)
  // An unpriced model costs 0 here; showing "$0.00" would read as free, so omit it.
  return cost > 0 ? `${tokens} · ${formatUsd(cost)}` : tokens
}

/** Hover-tooltip contents for the footer token counter (in/out, cache, cost). */
export function buildFooterUsageTooltip(
  display: FooterUsageDisplay,
  opts: FooterUsageTooltipOptions,
): FooterUsageTooltipModel {
  const { inputTokens, outputTokens, estimated } = display
  const approx = estimated ? '~' : ''
  const rows: FooterUsageTooltipRow[] = [
    { label: 'Input', value: `${approx}${formatTokenCount(inputTokens)}` },
    { label: 'Output', value: `${approx}${formatTokenCount(outputTokens)}` },
  ]

  const usage = opts.measuredUsage
  // Cache splits and pricing only make sense against provider-reported usage —
  // an estimate has neither a cache breakdown nor a trustworthy dollar figure.
  const cacheRead = estimated ? 0 : (usage.cacheReadTokens ?? 0)
  const cacheCreation = estimated ? 0 : (usage.cacheCreationTokens ?? 0)
  if (cacheRead > 0) rows.push({ label: 'Cache read', value: formatTokenCount(cacheRead) })
  if (cacheCreation > 0) rows.push({ label: 'Cache write', value: formatTokenCount(cacheCreation) })

  const cost = estimated ? '' : formatThreadUsageCost(usage, opts.model, opts.pricing)
  if (cost) rows.push({ label: 'Cost', value: cost })

  // Subagent tokens are already counted in the totals above; this row says how
  // much of that was delegated. Suppressed on an estimate, which has no
  // provider-reported subagent usage to draw on.
  const subagents = estimated
    ? { runs: 0, inputTokens: 0, outputTokens: 0 }
    : sumSubagentUsage(opts.messages)
  const subagentRow: FooterUsageTooltipRow | null =
    subagents.runs > 0
      ? {
          label: 'Subagents',
          value: `${String(subagents.runs)} ${subagents.runs === 1 ? 'run' : 'runs'} · ${formatTokenCount(
            subagents.inputTokens,
          )} in / ${formatTokenCount(subagents.outputTokens)} out`,
        }
      : null

  const modelRows: FooterUsageTooltipRow[] = []
  const byModel = Object.entries(usage.byModel ?? {}).filter(
    ([, u]) => u.inputTokens > 0 || u.outputTokens > 0,
  )
  if (!estimated && byModel.length > 1) {
    for (const [model, modelUsage] of byModel) {
      modelRows.push({ label: model, value: modelRowValue(model, modelUsage, opts.pricing) })
    }
  }

  const note = estimated
    ? 'Estimated — provider usage not reported yet'
    : cost
      ? null
      : 'No pricing for this model'

  return {
    header: `Usage · ${approx}${formatTokenCount(inputTokens + outputTokens)} tokens`,
    rows,
    subagentRow,
    modelRows,
    note,
  }
}
