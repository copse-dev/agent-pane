import {
  costForModelUsage,
  formatThreadUsageCost,
  hasModelPricing,
  hasZeroModelPricing,
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
  /** Headline: thread tokens excluding recorded subagent runs, `~`-prefixed when estimated. */
  header: string
  /**
   * Label for `rows` ("Excluding subagents"), shown only alongside
   * `subagentRow` so the scope of the headline is explicit.
   */
  conversationLabel: string | null
  /** Input/output matching the headline — one row per line. */
  rows: FooterUsageTooltipRow[]
  /** Label for whole-thread cache, cost, subagent, and per-model accounting. */
  threadLabel: string | null
  /** Cache and cost rows, which use the provider's whole-thread accounting. */
  threadRows: FooterUsageTooltipRow[]
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
   * Why some of the usage above reads as free — a local model, or a route
   * listed at a zero rate — using the same predicates the cost/model rows do.
   * A model with no listed price is not free; `note` covers it. Null when
   * nothing in the thread is free.
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
 * Why `model`'s usage reads as free — the same predicates `modelRowValue` and
 * the cost line use: local models cost nothing to run, and a route can be
 * listed at a zero rate. A model outside the catalog/pricing map is *not*
 * free: it has no listed price, and `note` says so.
 */
function freeReason(model: string, pricing?: ModelPricingMap): string | null {
  if (isLocalModel(model)) return 'local model'
  if (hasZeroModelPricing(model, pricing)) return `${model} is listed at a zero rate`
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
  const threadRows: FooterUsageTooltipRow[] = []

  const usage = opts.measuredUsage
  // Cache splits and pricing only make sense against provider-reported usage —
  // an estimate has neither a cache breakdown nor a trustworthy dollar figure.
  const cacheRead = estimated ? 0 : (usage.cacheReadTokens ?? 0)
  const cacheCreation = estimated ? 0 : (usage.cacheCreationTokens ?? 0)
  if (cacheRead > 0) {
    threadRows.push({ label: 'Cache read', value: formatTokenCount(cacheRead) })
  }
  if (cacheCreation > 0) {
    threadRows.push({ label: 'Cache write', value: formatTokenCount(cacheCreation) })
  }

  const byModel = Object.entries(usage.byModel ?? {}).filter(
    ([, u]) => u.inputTokens > 0 || u.outputTokens > 0,
  )
  const pricedModels = byModel.length > 0 ? byModel.map(([model]) => model) : [opts.model]
  const freeNote = estimated ? null : buildFreeNote(pricedModels, opts.pricing)

  // "Free: local model" below already explains local usage; the cost line
  // does not repeat it as "(+ local free)".
  const cost = estimated
    ? ''
    : formatThreadUsageCost(usage, opts.model, opts.pricing, {
        localFreeExplained: pricedModels.some(isLocalModel),
      })
  if (cost) threadRows.push({ label: 'Cost', value: cost })

  // How much work was delegated, from the sessions' own records. Only the
  // share actually folded into the thread total is taken out of `display`
  // (see `resolveFooterUsage`). Suppressed on an estimate, which has no
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
  const conversationLabel = subagentRow ? 'Excluding subagents' : null
  const threadLabel = subagentRow ? 'Whole thread' : null

  const modelRows: FooterUsageTooltipRow[] = []
  if (!estimated && byModel.length > 1) {
    for (const [model, modelUsage] of byModel) {
      modelRows.push({ label: model, value: modelRowValue(model, modelUsage, opts.pricing) })
    }
  }

  const hasUnpricedUsage = pricedModels.some(
    (model) => !isLocalModel(model) && !hasModelPricing(model, opts.pricing),
  )
  const note = estimated
    ? 'Estimated — provider usage not reported yet'
    : hasUnpricedUsage
      ? cost
        ? 'Cost excludes models with no listed price'
        : 'No listed price for this model'
      : null

  return {
    header: `Usage · ${approx}${formatTokenCount(inputTokens + outputTokens)} tokens`,
    conversationLabel,
    rows,
    threadLabel,
    threadRows,
    subagentRow,
    modelRows,
    note,
    freeNote,
  }
}
