import { costForModelUsage, formatThreadUsageCost, isLocalModel } from '@copse/llm/estimate-cost.ts'
import type { ModelPricingMap } from '@copse/llm/model-pricing.ts'
import type { ModelUsage, ThreadUsage } from '@shared/types'
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
  /** Per-model tokens + cost, only when the thread spans more than one model. */
  modelRows: FooterUsageTooltipRow[]
  /** Why numbers are approximate or a cost is missing; null when neither applies. */
  note: string | null
}

export interface FooterUsageTooltipOptions {
  /** Concrete chat model, used to price usage that carries no per-model breakdown. */
  model: string
  measuredUsage: ThreadUsage
  pricing?: ModelPricingMap | undefined
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
    modelRows,
    note,
  }
}
