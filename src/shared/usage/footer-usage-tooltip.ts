import {
  costForModelUsage,
  formatThreadUsageCost,
  hasModelPricing,
  isLocalModel,
} from '@copse/llm/estimate-cost.ts'
import type { ModelPricingMap } from '@copse/llm/model-pricing.ts'
import type { Message, ModelUsage, ThreadUsage } from '@shared/types'
import type { FooterUsageDisplay } from './footer-usage-summary.ts'
import { sumSubagentUsage } from './footer-usage-summary.ts'
import { formatTokenCount, formatUsd } from './format-usage-summary.ts'

export type { SubagentUsageTotals } from './footer-usage-summary.ts'
export { sumSubagentUsage } from './footer-usage-summary.ts'

export interface FooterUsageTooltipRow {
  label: string
  value: string
}

export interface FooterUsageTooltipModel {
  /** Headline: parent-only tokens, `~`-prefixed when the counts are estimated. */
  header: string
  /**
   * Label for `rows` ("This conversation"), shown only alongside `subagentRow`
   * — with nothing to contrast against, the breakdown obviously *is* the whole
   * conversation and the label would be noise.
   */
  conversationLabel: string | null
  /** In/out (plus cache and cost when known) for the parent loop — one row per line. */
  rows: FooterUsageTooltipRow[]
  /**
   * How much of the total came from delegated work; null when no subagent in
   * the thread has reported usage. Not folded into `rows` above.
   */
  subagentRow: FooterUsageTooltipRow | null
  /** Per-model tokens + cost, only when the thread spans more than one model. */
  modelRows: FooterUsageTooltipRow[]
  /** Why numbers are approximate or a cost is missing; null when neither applies. */
  note: string | null
  /**
   * Why some of the usage above reads as free — a local model, or a route with
   * no listed price — using the same predicates the cost/model rows do. Null
   * when nothing in the thread is free.
   */
  freeNote: string | null
}

export interface FooterUsageTooltipOptions {
  /** Concrete chat model, used to price usage that carries no per-model breakdown. */
  model: string
  measuredUsage: ThreadUsage
  /** Thread messages, walked for per-subagent usage records. */
  messages: Message[]
  pricing?: ModelPricingMap | undefined
}

function modelRowValue(model: string, usage: ModelUsage, pricing?: ModelPricingMap): string {
  const tokens = `${formatTokenCount(usage.inputTokens)} in / ${formatTokenCount(usage.outputTokens)} out`
  if (isLocalModel(model)) return `${tokens} · free`
  const cost = costForModelUsage(model, usage, pricing)
  if (!hasModelPricing(model, pricing)) return `${tokens} · unpriced`
  return `${tokens} · ${cost > 0 ? formatUsd(cost) : 'free'}`
}

/**
 * Why `model`'s usage would read as free rather than a dollar figure — the
 * same two predicates `modelRowValue` and the cost line use: local models cost
 * nothing to run, and a model outside the catalog/pricing map has no rate to
 * bill against. A model with a real (even zero) published rate is not
 * ambiguous, so it gets no explanation here.
 */
function freeReason(model: string, pricing?: ModelPricingMap): string | null {
  if (isLocalModel(model)) return 'local model'
  if (!hasModelPricing(model, pricing)) return `${model} has no listed price`
  return null
}

function buildFreeNote(models: string[], pricing?: ModelPricingMap): string | null {
  const reasons: string[] = []
  for (const model of models) {
    const reason = freeReason(model, pricing)
    if (reason && !reasons.includes(reason)) reasons.push(reason)
  }
  return reasons.length > 0 ? `Free: ${reasons.join('; ')}` : null
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

  // Subagent tokens are already counted in the parent's raw totals upstream
  // (see `resolveFooterUsage`), which folds them back out of `display` before
  // this row says how much of them was delegated. Suppressed on an estimate,
  // which has no provider-reported subagent usage to draw on.
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
  const conversationLabel = subagentRow ? 'This conversation' : null

  const modelRows: FooterUsageTooltipRow[] = []
  const byModel = Object.entries(usage.byModel ?? {}).filter(
    ([, u]) => u.inputTokens > 0 || u.outputTokens > 0,
  )
  if (!estimated && byModel.length > 1) {
    for (const [model, modelUsage] of byModel) {
      modelRows.push({ label: model, value: modelRowValue(model, modelUsage, opts.pricing) })
    }
  }

  const pricedModels = byModel.length > 0 ? byModel.map(([model]) => model) : [opts.model]
  const hasUnpricedUsage = pricedModels.some(
    (model) => !isLocalModel(model) && !hasModelPricing(model, opts.pricing),
  )
  const note = estimated
    ? 'Estimated — provider usage not reported yet'
    : hasUnpricedUsage
      ? cost
        ? 'Cost excludes models without pricing'
        : 'No pricing for this model'
      : null
  const freeNote = estimated ? null : buildFreeNote(pricedModels, opts.pricing)

  return {
    header: `Usage · ${approx}${formatTokenCount(inputTokens + outputTokens)} tokens`,
    conversationLabel,
    rows,
    subagentRow,
    modelRows,
    note,
    freeNote,
  }
}
