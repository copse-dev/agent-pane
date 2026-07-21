// The "model value map": a small scatter of every intellect-scored model on
// intellect (y, canonical Intelligence Index scale) vs cost (x), with the
// Pareto frontier drawn through the undominated points. Cost defaults to
// blended $/MTok at the 80/20 mix; a toggle switches X to Artificial
// Analysis cost-per-Intelligence-Index-task (verbosity-aware). Answers
// "which models are worth their price" at a glance; each point's native
// tooltip carries the full derivation (measurement, citation, any
// equating/quant adjustment) from `explainIntellectScore` so no number is
// unexplained.
//
// Composite-scored local models (copse-intellect scale) are deliberately NOT
// plotted — their scale is not the canonical index scale, and mixing scales
// would fake a comparison. They are listed beneath the chart instead.
//
// Rendering notes: one series with an emphasis state (accent = on frontier,
// neutral = dominated, hollow = estimated), direct labels because the point
// count is small, text/grid on theme tokens so light/dark both work, no
// second y-axis ever.

import {
  blendedPricePerMTok,
  blendedRate,
  computeParetoFrontier,
  frontierForKnownModels,
  projectOntoCostAxis,
  type FrontierCandidate,
  type FrontierCostAxis,
  type FrontierPoint,
} from '@copse/llm/pareto-frontier.ts'
import { TRACKED_MODELS, getModelInfo } from '@copse/llm/model-catalog.ts'
import {
  getIntellectScore,
  explainIntellectScore,
  listIntellectScoredModelIds,
  resolveIntellectModelId,
  INTELLECT_ATTRIBUTION,
} from '@copse/llm/model-intellect.ts'
import { liveIntellectCandidates, type LiveAaModel } from '@copse/llm/live-intellect.ts'
import type { ExtraProvider } from '@copse/llm/extra-providers.ts'
import { compositeIntellect, type CompositeIntellect } from '@copse/llm/composite-intellect.ts'
import { getLocalModelCapability, localBenchmarkScore } from '@copse/llm/local-model-catalog.ts'
import { isZeroRetentionModelPath } from '@copse/llm/data-policies.ts'
import type { PlanUsageSnapshot } from '@copse/plan-usage'
import { applyPlanCoverage } from './plan-inclusion.ts'
import { el } from '../dom/helpers.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'

const WIDTH = 460
const HEIGHT = 290
// A tight right margin: labels no longer need a wide reserved gutter because a
// point near the right edge flips its label to the left (see the label
// placement below), so the plot itself claims almost the full panel width.
const MARGIN = { top: 14, right: 20, bottom: 34, left: 40 }

/**
 * Compact display form of a model id for chart labels: provider prefixes and
 * vendor org paths are wrappers, not identity, so `huggingface:zai-org/
 * GLM-5.2:deepinfra` reads as `GLM-5.2:deepinfra`. Tooltips keep the full id.
 */
export function displayModelLabel(id: string): string {
  let s = id
  const sep = s.indexOf(':')
  if (sep > 0 && !s.slice(0, sep).includes('/')) s = s.slice(sep + 1)
  const slash = s.lastIndexOf('/')
  if (slash >= 0) s = s.slice(slash + 1)
  return s || id
}

/** Rough label width for collision purposes (9px font ≈ 5.2px/char). */
function approxLabelWidth(text: string): number {
  return 10 + text.length * 5.2
}

function svgEl(
  tag: string,
  attrs: Record<string, string>,
  ...children: (Node | string)[]
): SVGElement {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  node.append(...children)
  return node
}

/** Frontier input for the loaded local models: only canonical-scale scores. */
export function localFrontierCandidates(localModelIds: readonly string[]): FrontierCandidate[] {
  const out: FrontierCandidate[] = []
  for (const id of localModelIds) {
    const cap = getLocalModelCapability(id)
    if (!cap) continue
    const score = localBenchmarkScore(cap, 'aa-intelligence')
    if (!score) continue
    out.push({
      id,
      intellect: score.value,
      intellectEstimated: score.estimated === true,
      costPerMTok: 0,
      local: true,
      quant: cap.quant,
    })
  }
  return out
}

/**
 * Frontier input for extra-provider models (Hugging Face router, Mistral,
 * DeepSeek, user-added): any model with BOTH a stored per-MTok rate and a
 * resolvable intellect measurement joins the graph at its real price. Models
 * missing either stay off — a hint-only picker row is as far as an unpriced
 * measurement goes.
 */
export function extraProviderFrontierCandidates(
  providers: readonly ExtraProvider[],
): FrontierCandidate[] {
  const out: FrontierCandidate[] = []
  for (const provider of providers) {
    for (const m of provider.models) {
      if (typeof m.inputPricePerMTok !== 'number') continue
      const score = getIntellectScore(m.id)
      if (!score) continue
      out.push({
        id: `${provider.id}:${m.id}`,
        intellect: score.value,
        intellectEstimated: score.estimated === true,
        costPerMTok: blendedRate(m.inputPricePerMTok, m.outputPricePerMTok ?? m.inputPricePerMTok),
      })
    }
  }
  return out
}

export interface CompositeScoredModel {
  id: string
  composite: CompositeIntellect
}

/** Local models whose only capability number is the composite (own scale). */
export function compositeScoredLocalModels(
  localModelIds: readonly string[],
): CompositeScoredModel[] {
  const out: CompositeScoredModel[] = []
  for (const id of localModelIds) {
    const cap = getLocalModelCapability(id)
    if (!cap || cap.benchmarks['aa-intelligence']) continue
    const composite = compositeIntellect(cap)
    if (composite) out.push({ id, composite })
  }
  return out
}

/**
 * The composite models' own chart: a one-axis dot strip on the copse-intellect
 * 0–100 scale. A SEPARATE chart, deliberately — composite values are not on
 * the canonical index scale, and plotting them into the main scatter would
 * fake a comparison (and be a second y-scale in disguise).
 */
export function renderCompositeStrip(models: readonly CompositeScoredModel[]): SVGSVGElement {
  const height = 46 + models.length * 14
  const axisY = height - 18
  const left = 40
  const right = 16
  const plotW = WIDTH - left - right
  const x = (value: number): number => left + (value / 100) * plotW

  const svg = svgEl('svg', {
    viewBox: `0 0 ${String(WIDTH)} ${String(height)}`,
    role: 'img',
    'aria-label': 'Local models on the copse-intellect composite scale',
    style: 'width:100%;height:auto;display:block',
  }) as SVGSVGElement

  svg.append(
    svgEl('line', {
      x1: String(left),
      x2: String(left + plotW),
      y1: String(axisY),
      y2: String(axisY),
      stroke: 'var(--border)',
      'stroke-width': '1',
    }),
  )
  for (const t of [0, 25, 50, 75, 100]) {
    svg.append(
      svgEl(
        'text',
        {
          x: String(x(t)),
          y: String(axisY + 12),
          'text-anchor': 'middle',
          'font-size': '9',
          fill: 'var(--text-muted)',
        },
        String(t),
      ),
    )
  }
  models.forEach((m, i) => {
    const cy = axisY - 12 - i * 14
    const cx = String(x(m.composite.value))
    const dot = svgEl('circle', {
      cx,
      cy: String(cy),
      r: '5',
      fill: 'var(--bg-base)',
      stroke: 'var(--border-strong)',
      'stroke-width': '2',
      class: 'composite-point',
    })
    dot.append(
      svgEl(
        'title',
        {},
        `${m.id}\ncomposite ${String(m.composite.value)} — ${m.composite.version} (own scale, not the canonical index)\n${m.composite.basis}\ncost: free (runs on-device)`,
      ),
    )
    svg.append(
      dot,
      svgEl(
        'text',
        {
          x: String(x(m.composite.value) + 9),
          y: String(cy + 3),
          'font-size': '9',
          fill: 'var(--text-secondary)',
          class: 'composite-label',
        },
        `${m.id} · ${String(m.composite.value)}`,
      ),
    )
  })
  return svg
}

/** Hover layer contract: renderers hand over content, the panel positions it. */
export interface FrontierTooltip {
  show: (content: HTMLElement, evt: MouseEvent) => void
  hide: () => void
}

function ttRow(cls: string, ...children: (Node | string)[]): HTMLElement {
  return el('div', { class: cls }, ...children)
}

const formatPrice = (v: number): string => `$${String(Number(v.toFixed(2)))}/MTok`
const formatTaskPrice = (v: number): string => `$${String(Number(v.toFixed(2)))}/task`

/** Drop frontier annotations so a point can be re-projected onto another cost axis. */
function asFrontierCandidate(p: FrontierPoint): FrontierCandidate {
  const { onFrontier: _onFrontier, dominatedBy: _dominatedBy, ...candidate } = p
  return candidate
}

/** ", resets Tue" from an ISO reset time, or '' when unknown/unparseable. */
function formatReset(resetsAt: string | null): string {
  if (!resetsAt) return ''
  const d = new Date(resetsAt)
  if (Number.isNaN(d.getTime())) return ''
  return `, resets ${d.toLocaleDateString(undefined, { weekday: 'short' })}`
}

/**
 * Rich hover card for a plotted point: bold identity, the score's full
 * derivation, every known price for the same weights, and frontier status.
 */
export function pointTooltipContent(
  p: FrontierPoint,
  costAxis: FrontierCostAxis = 'blended',
): HTMLElement {
  const root = el('div', { class: 'frontier-tooltip-content' })
  const label = displayModelLabel(p.id)
  root.append(ttRow('tt-title', el('strong', {}, label)))
  if (label !== p.id) root.append(ttRow('tt-muted', p.id))

  root.append(ttRow('tt-section', 'Score'))
  const explanation = explainIntellectScore(p.id)
  if (explanation) {
    root.append(
      ttRow(
        'tt-line',
        el('strong', {}, `${p.intellectEstimated ? '~' : ''}${String(p.intellect)}`),
        ` — ${explanation.scale}`,
      ),
    )
    for (const step of explanation.steps) {
      root.append(ttRow('tt-muted', `${step.step}: ${step.detail}`))
    }
  } else {
    root.append(
      ttRow(
        'tt-line',
        el('strong', {}, `~${String(p.intellect)}`),
        ' — live Artificial Analysis value (not yet curated)',
      ),
    )
  }
  if (p.quant && p.intellectEstimated) {
    root.append(
      ttRow(
        'tt-muted',
        `Adjusted down for ${p.quant} quantisation — an estimate, not a measurement.`,
      ),
    )
  }

  root.append(ttRow('tt-section', p.prices?.length ? 'Prices' : 'Price'))
  const blended =
    p.blendedCostPerMTok ??
    (p.planDetail !== undefined ? p.planDetail.apiPricePerMTok : p.costPerMTok)
  const priceLine = p.plan
    ? el(
        'span',
        {},
        el('strong', {}, 'included in your plan'),
        costAxis === 'perTask'
          ? ` (${p.plan}) — ~$0 marginal task cost`
          : ` (${p.plan}) — ~$0 marginal token cost`,
      )
    : p.local
      ? el('span', {}, 'free (runs on-device)')
      : costAxis === 'perTask'
        ? el('span', {}, `${formatTaskPrice(p.costPerMTok)} AA Intelligence Index task (plotted)`)
        : el(
            'span',
            {},
            `${formatPrice(p.costPerMTok)} blended (80% in / 20% out)`,
            ...(p.prices?.length ? [' — best offer, plotted'] : []),
          )
  root.append(ttRow('tt-line', priceLine))
  if (costAxis === 'perTask') {
    if (!p.local && !p.plan) {
      root.append(
        ttRow('tt-muted', `${formatPrice(blended)} blended list price (80% in / 20% out).`),
      )
    }
  } else if (typeof p.costPerTask === 'number') {
    root.append(
      ttRow(
        'tt-muted',
        `Artificial Analysis cost per Intelligence Index task: ${formatTaskPrice(p.costPerTask)} (reflects verbosity, not just token price).`,
      ),
    )
  }
  for (const offer of p.prices ?? []) {
    root.append(
      ttRow('tt-muted', `${displayModelLabel(offer.id)}: ${formatPrice(offer.costPerMTok)}`),
    )
  }
  // Plan-covered: how much of the window is used + the off-plan fallback price.
  if (p.plan && p.planDetail) {
    root.append(
      ttRow(
        'tt-muted',
        `${String(Math.round(p.planDetail.usedPercent))}% of this plan window used${formatReset(p.planDetail.resetsAt)}.`,
      ),
      ttRow('tt-muted', `Off-plan you'd pay ${formatPrice(p.planDetail.apiPricePerMTok)} blended.`),
    )
  }
  // Plan window spent: it's plotted at its real price now, not as included.
  if (p.planLimitReached) {
    root.append(
      ttRow(
        'tt-muted',
        `${p.planLimitReached.label} plan limit reached${formatReset(p.planLimitReached.resetsAt)} — plotted at its off-plan price.`,
      ),
    )
  }

  root.append(
    ttRow(
      'tt-status',
      p.discovery
        ? p.onFrontier
          ? 'Not configured — setting up a provider would put this ON your value frontier.'
          : 'Not configured — available via Artificial Analysis if you set up a provider.'
        : p.onFrontier
          ? 'On the value frontier'
          : `Dominated by ${displayModelLabel(p.dominatedBy ?? '?')}`,
    ),
  )
  return root
}

/** Hover card for a right-gutter (scored, unpriced) model. */
export function unpricedTooltipContent(u: CanonicalScoredModel): HTMLElement {
  const root = el('div', { class: 'frontier-tooltip-content' })
  root.append(ttRow('tt-title', el('strong', {}, displayModelLabel(u.id))))
  if (displayModelLabel(u.id) !== u.id) root.append(ttRow('tt-muted', u.id))
  root.append(ttRow('tt-section', 'Score'))
  const explanation = explainIntellectScore(u.id)
  root.append(ttRow('tt-line', el('strong', {}, `${u.estimated ? '~' : ''}${String(u.intellect)}`)))
  for (const step of explanation?.steps ?? []) {
    root.append(ttRow('tt-muted', `${step.step}: ${step.detail}`))
  }
  root.append(ttRow('tt-status', 'No price data yet — position on intellect only.'))
  return root
}

/** Hover card for a bottom-gutter (priced, unscored) model. */
export function unscoredTooltipContent(u: { id: string; costPerMTok: number }): HTMLElement {
  const root = el('div', { class: 'frontier-tooltip-content' })
  root.append(ttRow('tt-title', el('strong', {}, displayModelLabel(u.id))))
  if (displayModelLabel(u.id) !== u.id) root.append(ttRow('tt-muted', u.id))
  root.append(ttRow('tt-section', 'Price'))
  root.append(ttRow('tt-line', `${formatPrice(u.costPerMTok)} blended (80% in / 20% out)`))
  root.append(ttRow('tt-status', 'No sourced intellect measurement yet — position on price only.'))
  return root
}

const TOOLTIP_OFFSET_PX = 12

/**
 * Place a hover card beside the cursor without squeezing it into a tall column.
 * Near the right edge, shrink-to-fit width uses only the remaining horizontal
 * room — the same failure mode the chart labels avoid by flipping anchor.
 */
export function positionFrontierTooltip(
  tip: HTMLElement,
  container: HTMLElement,
  evt: Pick<MouseEvent, 'clientX' | 'clientY'>,
): void {
  const rect = container.getBoundingClientRect()
  const tipWidth = tip.offsetWidth
  const tipHeight = tip.offsetHeight
  const cursorX = evt.clientX - rect.left
  const cursorY = evt.clientY - rect.top

  let left = cursorX + TOOLTIP_OFFSET_PX
  if (left + tipWidth > rect.width) {
    left = cursorX - tipWidth - TOOLTIP_OFFSET_PX
  }
  left = Math.max(0, Math.min(left, Math.max(0, rect.width - tipWidth)))

  let top = cursorY + TOOLTIP_OFFSET_PX
  if (top + tipHeight > rect.height) {
    top = cursorY - tipHeight - TOOLTIP_OFFSET_PX
  }
  top = Math.max(0, Math.min(top, Math.max(0, rect.height - tipHeight)))

  tip.style.left = `${String(left)}px`
  tip.style.top = `${String(top)}px`
}

/** A positioned hover layer inside `container` (which must be a positioning context). */
export function createTooltipLayer(container: HTMLElement): FrontierTooltip {
  const tip = el('div', { class: 'frontier-tooltip', hidden: true })
  container.append(tip)
  return {
    show(content, evt): void {
      tip.replaceChildren(content)
      tip.hidden = false
      positionFrontierTooltip(tip, container, evt)
    },
    hide(): void {
      tip.hidden = true
    },
  }
}

function wireTooltip(
  target: SVGElement,
  tooltip: FrontierTooltip | undefined,
  build: () => HTMLElement,
): void {
  if (!tooltip) return
  target.addEventListener('mouseenter', (evt) => {
    tooltip.show(build(), evt)
  })
  target.addEventListener('mousemove', (evt) => {
    tooltip.show(build(), evt)
  })
  target.addEventListener('mouseleave', () => {
    tooltip.hide()
  })
}

function tooltipFor(point: FrontierPoint, costAxis: FrontierCostAxis = 'blended'): string {
  const lines: string[] = [point.id]
  const explanation = explainIntellectScore(point.id)
  if (explanation) {
    lines.push(`intellect ${String(explanation.value)} — ${explanation.scale}`)
    for (const step of explanation.steps) lines.push(`${step.step}: ${step.detail}`)
  } else {
    lines.push(`intellect ${point.intellectEstimated ? '~' : ''}${String(point.intellect)}`)
  }
  lines.push(
    point.local
      ? 'cost: free (runs on-device)'
      : point.plan
        ? `cost: included in plan (${point.plan})`
        : costAxis === 'perTask'
          ? `cost: $${String(point.costPerMTok)}/task AA Intelligence Index`
          : `cost: $${String(point.costPerMTok)}/MTok blended (80% input / 20% output)`,
  )
  lines.push(
    point.onFrontier ? 'On the value frontier' : `Dominated by ${point.dominatedBy ?? '?'}`,
  )
  return lines.join('\n')
}

/** Nice round tick values covering [0, max]. */
function ticks(max: number, count: number): number[] {
  const step = Math.max(1, Math.ceil(max / count))
  const out: number[] = []
  for (let v = 0; v <= max; v += step) out.push(v)
  return out
}

/** Models that have one coordinate but not the other — chart-margin gutters. */
export interface FrontierGutters {
  /** Scored on the canonical scale, no price — right gutter, true y position. */
  unpriced?: readonly CanonicalScoredModel[]
  /** Priced, no sourced score — bottom gutter, true x position. */
  unscored?: readonly { id: string; costPerMTok: number }[]
}

const UNPRICED_GUTTER_W = 150

/**
 * Above this many priced-but-unscored models, per-model gutter rows are noise:
 * the band collapses to a single density row (dots at true price, ids on
 * hover) and the panel lists the models behind a disclosure instead.
 */
export const UNSCORED_ROW_LIMIT = 8

/** Highest-intellect unpriced models shown as gutter dots; rest go to a list. */
export const UNPRICED_GUTTER_LIMIT = 8

export function renderFrontierSvg(
  points: readonly FrontierPoint[],
  size: { width?: number; height?: number } = {},
  gutters: FrontierGutters = {},
  tooltip?: FrontierTooltip,
  costAxis: FrontierCostAxis = 'blended',
): SVGSVGElement {
  const unpriced = gutters.unpriced ?? []
  // Bottom gutter (priced, no intellect) only applies on the blended axis — on
  // the task axis those models also lack a task-cost coordinate, so they stay
  // in the disclosure list rather than claiming a false X position.
  const unscored = costAxis === 'blended' ? (gutters.unscored ?? []) : []
  const gutterW = unpriced.length > 0 ? UNPRICED_GUTTER_W : 0
  const baseHeight = size.height ?? HEIGHT
  const width = (size.width ?? WIDTH) + gutterW
  const plotW = width - gutterW - MARGIN.left - MARGIN.right
  const plotH = baseHeight - MARGIN.top - MARGIN.bottom
  // The unpriced gutter is a LEFT column: it shares the intellect (y) axis but
  // has no price, so it sits before the priced plot rather than after it (the
  // right side is where the priciest models and their labels live).
  const plotLeft = gutterW + MARGIN.left
  const allCosts = [...points.map((p) => p.costPerMTok), ...unscored.map((u) => u.costPerMTok)]
  const allIntellects = [...points.map((p) => p.intellect), ...unpriced.map((u) => u.intellect)]
  const maxCost = Math.max(1, ...allCosts) * 1.08
  const maxIntellect = Math.max(10, ...allIntellects) + 5
  const minIntellect = Math.max(0, Math.min(...allIntellects) - 8)
  const x = (cost: number): number => plotLeft + (cost / maxCost) * plotW
  const y = (intellect: number): number =>
    MARGIN.top + plotH - ((intellect - minIntellect) / (maxIntellect - minIntellect)) * plotH

  // Bottom-gutter rows assigned greedily so labels never overlap within a row.
  // Past UNSCORED_ROW_LIMIT the band collapses to one label-less density row.
  const dense = unscored.length > UNSCORED_ROW_LIMIT
  const unscoredRows: Array<{ id: string; costPerMTok: number; row: number; text: string }> = []
  {
    const rowEnds: number[] = []
    for (const u of [...unscored].sort((a, b) => a.costPerMTok - b.costPerMTok)) {
      if (dense) {
        unscoredRows.push({ id: u.id, costPerMTok: u.costPerMTok, row: 0, text: '' })
        continue
      }
      const text = displayModelLabel(u.id)
      const x0 = x(u.costPerMTok) - 6
      const x1 = x(u.costPerMTok) + 8 + approxLabelWidth(text)
      let row = rowEnds.findIndex((end) => end < x0)
      if (row === -1) {
        row = rowEnds.length
        rowEnds.push(x1)
      } else {
        rowEnds[row] = x1
      }
      unscoredRows.push({ id: u.id, costPerMTok: u.costPerMTok, row, text })
    }
  }
  const unscoredRowCount = unscoredRows.reduce((m, u) => Math.max(m, u.row + 1), 0)
  const bottomGutterH = unscoredRowCount > 0 ? 12 + unscoredRowCount * 12 : 0
  const height = baseHeight + bottomGutterH

  const xAxisLabel =
    costAxis === 'perTask'
      ? 'AA cost per Intelligence Index task ($) — local/plan models plot at $0'
      : 'blended price, $/MTok (80% in / 20% out) — local models plot at $0'
  const ariaLabel =
    costAxis === 'perTask'
      ? 'Model intellect versus AA cost per Intelligence Index task, with the Pareto frontier'
      : 'Model intellect versus blended price, with the Pareto frontier'

  const svg = svgEl('svg', {
    viewBox: `0 0 ${String(width)} ${String(height)}`,
    role: 'img',
    'aria-label': ariaLabel,
    'data-cost-axis': costAxis,
    style: 'width:100%;height:auto;display:block',
  }) as SVGSVGElement

  // Recessive grid: a few horizontal lines only.
  for (const t of ticks(maxIntellect, 4)) {
    if (t < minIntellect) continue
    svg.append(
      svgEl('line', {
        x1: String(plotLeft),
        x2: String(plotLeft + plotW),
        y1: String(y(t)),
        y2: String(y(t)),
        stroke: 'var(--border-subtle)',
        'stroke-width': '1',
      }),
      svgEl(
        'text',
        {
          x: String(plotLeft - 6),
          y: String(y(t) + 3),
          'text-anchor': 'end',
          'font-size': '9',
          fill: 'var(--text-muted)',
        },
        String(t),
      ),
    )
  }
  // X axis line + ticks.
  svg.append(
    svgEl('line', {
      x1: String(plotLeft),
      x2: String(plotLeft + plotW),
      y1: String(MARGIN.top + plotH),
      y2: String(MARGIN.top + plotH),
      stroke: 'var(--border)',
      'stroke-width': '1',
    }),
  )
  for (const t of ticks(maxCost, 5)) {
    svg.append(
      svgEl(
        'text',
        {
          x: String(x(t)),
          y: String(MARGIN.top + plotH + 14),
          'text-anchor': 'middle',
          'font-size': '9',
          fill: 'var(--text-muted)',
        },
        `$${String(t)}`,
      ),
    )
  }
  svg.append(
    svgEl(
      'text',
      {
        x: String(plotLeft + plotW / 2),
        y: String(height - 4),
        'text-anchor': 'middle',
        'font-size': '9',
        fill: 'var(--text-secondary)',
        class: 'frontier-x-axis-label',
      },
      xAxisLabel,
    ),
    svgEl(
      'text',
      {
        x: String(gutterW + 10),
        y: String(MARGIN.top + plotH / 2),
        transform: `rotate(-90 ${String(gutterW + 10)} ${String(MARGIN.top + plotH / 2)})`,
        'text-anchor': 'middle',
        'font-size': '9',
        fill: 'var(--text-secondary)',
      },
      'intellect (canonical index)',
    ),
  )

  // Frontier line through the undominated points, cost-ascending.
  const frontier = points.filter((p) => p.onFrontier)
  if (frontier.length > 1) {
    svg.append(
      svgEl('polyline', {
        points: frontier
          .map((p) => `${String(x(p.costPerMTok))},${String(y(p.intellect))}`)
          .join(' '),
        fill: 'none',
        stroke: 'var(--accent)',
        'stroke-width': '2',
        'stroke-opacity': '0.45',
        class: 'frontier-line',
      }),
    )
  }

  // Direct labels sit beside their point, in compact display form (full ids
  // stay in the tooltip). Collision layout is interval-aware: a label bumps
  // down until its horizontal extent overlaps nothing on its row. Frontier
  // points are placed FIRST so they win the room; a label that can only land
  // below the plot is DROPPED (the point stays hover-only) so the cascade can
  // never overflow the axis into the copy below. A label whose natural right
  // placement would run off the (now tight) right edge FLIPS to the left of its
  // point instead, so the trimmed margin never clips it.
  const labelledPoints = [...points].sort(
    (a, b) => Number(b.onFrontier) - Number(a.onFrontier) || y(a.intellect) - y(b.intellect),
  )
  const plotBottom = MARGIN.top + plotH
  const rightEdge = width - 2
  const labelText = new Map<string, string>()
  const labelY = new Map<string, number>()
  const labelX = new Map<string, number>()
  const labelAnchor = new Map<string, string>()
  // Dots are obstacles too — a label must not sit under another point's mark.
  const placed: Array<{ x0: number; x1: number; py: number }> = points.map((p) => ({
    x0: x(p.costPerMTok) - 7,
    x1: x(p.costPerMTok) + 7,
    py: y(p.intellect) + 3,
  }))
  for (const p of labelledPoints) {
    const suffix = p.plan ? ' · plan' : p.local ? ' · free' : ''
    const text = `${displayModelLabel(p.id)}${p.quant ? ` @${p.quant}` : ''}${p.intellectEstimated ? ' (~)' : ''}${suffix}`
    const w = approxLabelWidth(text)
    const px = x(p.costPerMTok)
    // Prefer a right-hand label; flip to the left for points near the right
    // edge. Drop only when neither side fits horizontally.
    let x0: number
    let x1: number
    let tx: number
    let anchor: string
    if (px + 8 + w <= rightEdge) {
      x0 = px + 8
      x1 = px + 8 + w
      tx = px + 8
      anchor = 'start'
    } else if (px - 8 - w >= plotLeft) {
      x0 = px - 8 - w
      x1 = px - 8
      tx = px - 8
      anchor = 'end'
    } else {
      continue
    }
    let py = y(p.intellect) + 3
    let moved = true
    while (moved) {
      moved = false
      for (const prev of placed) {
        // Only resolve a collision when it actually pushes the label DOWN. The
        // naive `py = prev.py + 10` can hit a floating-point fixed point where
        // |py − prev.py| rounds to just under 10 while prev.py + 10 === py, so
        // the assignment is a no-op yet `moved` stays true forever. Requiring a
        // strict increase drops only that artifact (a real overlap always
        // implies prev.py + 10 > py) and guarantees termination.
        const next = prev.py + 10
        if (next > py && Math.abs(py - prev.py) < 10 && x0 < prev.x1 && x1 > prev.x0) {
          py = next
          moved = true
        }
      }
    }
    // Drop a label that can only land below the plot — hover still has it.
    if (py > plotBottom) continue
    placed.push({ x0, x1, py })
    labelText.set(p.id, text)
    labelY.set(p.id, py)
    labelX.set(p.id, tx)
    labelAnchor.set(p.id, anchor)
  }

  // Points, with a larger transparent hit target and a rich hover card.
  for (const p of points) {
    const cx = String(x(p.costPerMTok))
    const cy = String(y(p.intellect))
    const emphasis = p.onFrontier ? 'var(--accent)' : 'var(--border-strong)'
    // Discovery points (not configured) are ghosted so they read as "could
    // set up" rather than "have"; hollow marks estimated, plan points get a
    // ring badge (drawn below).
    const cls = [
      'frontier-point',
      p.intellectEstimated ? 'estimated' : '',
      p.discovery ? 'discovery' : '',
      p.plan ? 'plan' : '',
    ]
      .filter(Boolean)
      .join(' ')
    const dot = p.intellectEstimated
      ? svgEl('circle', {
          cx,
          cy,
          r: '5',
          fill: 'var(--bg-base)',
          stroke: emphasis,
          'stroke-width': '2',
          ...(p.discovery ? { 'stroke-dasharray': '2 2', opacity: '0.7' } : {}),
          class: cls,
        })
      : svgEl('circle', {
          cx,
          cy,
          r: '5',
          fill: emphasis,
          ...(p.discovery ? { opacity: '0.55' } : {}),
          class: cls,
        })
    if (p.plan) {
      svg.append(
        svgEl('circle', {
          cx,
          cy,
          r: '8',
          fill: 'none',
          stroke: 'var(--accent)',
          'stroke-width': '1',
          'stroke-dasharray': '1 2',
          class: 'frontier-plan-badge',
        }),
      )
    }
    const hit = svgEl('circle', { cx, cy, r: '11', fill: 'transparent', class: 'frontier-hit' })
    if (tooltip) wireTooltip(hit, tooltip, () => pointTooltipContent(p, costAxis))
    else hit.append(svgEl('title', {}, tooltipFor(p, costAxis)))
    const text = labelText.get(p.id)
    if (text !== undefined) {
      svg.append(
        svgEl(
          'text',
          {
            x: String(labelX.get(p.id) ?? x(p.costPerMTok) + 8),
            y: String(labelY.get(p.id) ?? y(p.intellect) + 3),
            'text-anchor': labelAnchor.get(p.id) ?? 'start',
            'font-size': '9',
            fill: 'var(--text-secondary)',
            class: 'frontier-label',
          },
          text,
        ),
      )
    }
    svg.append(dot, hit)
  }

  // LEFT gutter: scored-but-unpriced models at their TRUE y on the shared
  // intellect axis, in a marked "no price" column before the priced plot (the
  // right side is where the priciest models and their labels sit). Labels point
  // LEFT (text-anchor end) so they stay inside the gutter's width.
  if (unpriced.length > 0) {
    const sepX = gutterW - 4
    const dotX = gutterW - 14
    svg.append(
      svgEl('line', {
        x1: String(sepX),
        x2: String(sepX),
        y1: String(MARGIN.top),
        y2: String(MARGIN.top + plotH),
        stroke: 'var(--border-subtle)',
        'stroke-width': '1',
        'stroke-dasharray': '3 3',
      }),
      svgEl(
        'text',
        {
          x: String(dotX + 2),
          y: String(MARGIN.top + plotH + 14),
          'text-anchor': 'end',
          'font-size': '9',
          fill: 'var(--text-muted)',
        },
        'no price yet',
      ),
    )
    // Cap the gutter so a big verified feed can't grow a tower of hundreds of
    // dots; the overflow is summarised in a banded disclosure by the panel.
    const sortedUnpriced = [...unpriced].sort((a, b) => b.intellect - a.intellect)
    const shownUnpriced = sortedUnpriced.slice(0, UNPRICED_GUTTER_LIMIT)
    let prevY = -Infinity
    for (const u of shownUnpriced) {
      const dotY = y(u.intellect)
      const labelYPos = Math.max(dotY + 3, prevY + 11)
      prevY = labelYPos
      const dot = u.estimated
        ? svgEl('circle', {
            cx: String(dotX),
            cy: String(dotY),
            r: '5',
            fill: 'var(--bg-base)',
            stroke: 'var(--accent)',
            'stroke-width': '2',
            class: 'gutter-unpriced estimated',
          })
        : svgEl('circle', {
            cx: String(dotX),
            cy: String(dotY),
            r: '5',
            fill: 'var(--accent)',
            class: 'gutter-unpriced',
          })
      if (tooltip) {
        wireTooltip(dot, tooltip, () => unpricedTooltipContent(u))
      } else {
        const explanation = explainIntellectScore(u.id)
        dot.append(
          svgEl(
            'title',
            {},
            explanation
              ? `${u.id}\n${explanation.steps.map((s) => `${s.step}: ${s.detail}`).join('\n')}\nNo price data yet — position on intellect only.`
              : `${u.id}\nintellect ${u.estimated ? '~' : ''}${String(u.intellect)} (live Artificial Analysis)\nNo price data yet — position on intellect only.`,
          ),
        )
      }
      svg.append(
        dot,
        svgEl(
          'text',
          {
            x: String(dotX - 9),
            y: String(labelYPos),
            'text-anchor': 'end',
            'font-size': '9',
            fill: 'var(--text-secondary)',
            class: 'gutter-unpriced-label',
          },
          `${displayModelLabel(u.id)} · ${u.estimated ? '~' : ''}${String(u.intellect)}`,
        ),
      )
    }
    if (sortedUnpriced.length > shownUnpriced.length) {
      svg.append(
        svgEl(
          'text',
          {
            x: String(dotX + 2),
            y: String(MARGIN.top + plotH - 4),
            'text-anchor': 'end',
            'font-size': '9',
            fill: 'var(--text-muted)',
            class: 'gutter-unpriced-more',
          },
          `+${String(sortedUnpriced.length - shownUnpriced.length)} in the list below`,
        ),
      )
    }
  }

  // Bottom gutter: priced-but-unscored models at their TRUE x on the shared
  // price axis, in a "no score" band under the axis.
  if (unscoredRows.length > 0) {
    // Unscored models cluster at low prices, so the dense caption sits at the
    // emptier right end of the band.
    svg.append(
      dense
        ? svgEl(
            'text',
            {
              x: String(MARGIN.left + plotW),
              y: String(baseHeight - 2),
              'text-anchor': 'end',
              'font-size': '9',
              fill: 'var(--text-muted)',
              class: 'gutter-unscored-caption',
            },
            `no score yet · ${String(unscoredRows.length)} models`,
          )
        : svgEl(
            'text',
            {
              x: '4',
              y: String(baseHeight - 2),
              'font-size': '9',
              fill: 'var(--text-muted)',
              class: 'gutter-unscored-caption',
            },
            'no score yet',
          ),
    )
    for (const u of unscoredRows) {
      const rowY = baseHeight - 6 + u.row * 12
      const dot = svgEl('circle', {
        cx: String(x(u.costPerMTok)),
        cy: String(rowY),
        r: dense ? '3' : '4',
        fill: 'var(--border-strong)',
        ...(dense ? { 'fill-opacity': '0.6' } : {}),
        class: dense ? 'gutter-unscored dense' : 'gutter-unscored',
      })
      if (tooltip) {
        wireTooltip(dot, tooltip, () => unscoredTooltipContent(u))
      } else {
        dot.append(
          svgEl(
            'title',
            {},
            `${u.id}\n$${String(u.costPerMTok)}/MTok blended (80% input / 20% output)\nNo sourced intellect measurement yet — position on price only.`,
          ),
        )
      }
      svg.append(dot)
      if (!dense && u.text) {
        svg.append(
          svgEl(
            'text',
            {
              x: String(x(u.costPerMTok) + 7),
              y: String(rowY + 3),
              'font-size': '9',
              fill: 'var(--text-secondary)',
              class: 'gutter-unscored-label',
            },
            u.text,
          ),
        )
      }
    }
  }
  return svg
}

export interface CanonicalScoredModel {
  id: string
  intellect: number
  estimated: boolean
}

/**
 * Canonical-scored models with no cost coordinate: curated measurements whose
 * model isn't plotted anywhere (no catalog/provider pricing), plus live-scored
 * unpriced models. They share the main chart's scale, so they get a one-axis
 * strip rather than being dropped to a footnote — position on intellect only.
 */
export function unpricedCanonicalModels(
  plottedIds: ReadonlySet<string>,
  liveHintOnly: readonly { id: string; intellect: number }[],
): CanonicalScoredModel[] {
  const out: CanonicalScoredModel[] = []
  for (const id of listIntellectScoredModelIds()) {
    if (plottedIds.has(id)) continue
    const score = getIntellectScore(id)
    if (!score) continue
    out.push({ id, intellect: score.value, estimated: score.estimated === true })
  }
  for (const live of liveHintOnly) {
    out.push({ id: live.id, intellect: live.intellect, estimated: true })
  }
  return out.sort((a, b) => b.intellect - a.intellect || a.id.localeCompare(b.id))
}

/**
 * Priced models with no sourced score: tracked cloud models whose measurement
 * is absent, plus priced extra-provider models nothing resolves for. They get
 * the bottom "no score" gutter at their true price.
 */
export function unscoredPricedModels(
  extraProviders: readonly ExtraProvider[],
): Array<{ id: string; costPerMTok: number }> {
  const out: Array<{ id: string; costPerMTok: number }> = []
  for (const id of TRACKED_MODELS) {
    const info = getModelInfo(id)
    if (!info || getIntellectScore(id)) continue
    out.push({ id, costPerMTok: blendedPricePerMTok(info) })
  }
  for (const provider of extraProviders) {
    for (const m of provider.models) {
      if (typeof m.inputPricePerMTok !== 'number' || getIntellectScore(m.id)) continue
      out.push({
        id: `${provider.id}:${m.id}`,
        costPerMTok: blendedRate(m.inputPricePerMTok, m.outputPricePerMTok ?? m.inputPricePerMTok),
      })
    }
  }
  return out.sort((a, b) => a.costPerMTok - b.costPerMTok || a.id.localeCompare(b.id))
}

export interface BandedRow {
  id: string
  intellect: number
  estimated?: boolean | undefined
  costPerMTok?: number | undefined
}

/**
 * Group rows into descending 10-point intellect bands, each row rendered as a
 * compact "name · ~intellect · $price" chip. Turns a flat wall of hundreds of
 * names into a scannable table where a reader can find "the dominated models
 * around intellect 40". Rows within a band sort by intellect then price.
 */
export function renderBandedModelList(rows: readonly BandedRow[]): HTMLElement {
  const bands = new Map<number, BandedRow[]>()
  for (const r of rows) {
    const band = Math.floor(r.intellect / 10) * 10
    const list = bands.get(band) ?? []
    list.push(r)
    bands.set(band, list)
  }
  const table = el('div', { class: 'frontier-banded' })
  for (const band of [...bands.keys()].sort((a, b) => b - a)) {
    const list = (bands.get(band) ?? []).sort(
      (a, b) => b.intellect - a.intellect || (a.costPerMTok ?? 0) - (b.costPerMTok ?? 0),
    )
    const chips = list
      .map((r) => {
        const price =
          r.costPerMTok === undefined ? '' : ` · $${String(Number(r.costPerMTok.toFixed(2)))}`
        return `${displayModelLabel(r.id)} (${r.estimated ? '~' : ''}${String(r.intellect)}${price})`
      })
      .join(' · ')
    table.append(
      el(
        'div',
        { class: 'frontier-band-row' },
        el('span', { class: 'frontier-band-key' }, `${String(band)}–${String(band + 9)}`),
        el('span', { class: 'frontier-band-count' }, String(list.length)),
        el('span', { class: 'frontier-band-models' }, chips),
      ),
    )
  }
  return table
}

/**
 * Group priced-but-unscored models by the provider prefix in their id
 * (`huggingface:vendor/model:route` → "huggingface"), cheapest first within a
 * group. The provider is the meaningful axis for "what could I score next".
 */
export function renderProviderGroupedList(
  rows: ReadonlyArray<{ id: string; costPerMTok: number }>,
): HTMLElement {
  const groups = new Map<string, Array<{ id: string; costPerMTok: number }>>()
  for (const r of rows) {
    const sep = r.id.indexOf(':')
    const provider = sep > 0 && !r.id.slice(0, sep).includes('/') ? r.id.slice(0, sep) : 'cloud'
    const list = groups.get(provider) ?? []
    list.push(r)
    groups.set(provider, list)
  }
  const table = el('div', { class: 'frontier-banded' })
  for (const provider of [...groups.keys()].sort()) {
    const list = (groups.get(provider) ?? []).sort((a, b) => a.costPerMTok - b.costPerMTok)
    const chips = list
      .map((r) => `${displayModelLabel(r.id)} ($${String(Number(r.costPerMTok.toFixed(2)))})`)
      .join(' · ')
    table.append(
      el(
        'div',
        { class: 'frontier-band-row' },
        el('span', { class: 'frontier-band-key' }, provider),
        el('span', { class: 'frontier-band-count' }, String(list.length)),
        el('span', { class: 'frontier-band-models' }, chips),
      ),
    )
  }
  return table
}

/**
 * Render the scatter, guarding against a render error taking the whole settings
 * dialog down — a broken chart degrades to a quiet note. Shared by the inline
 * panel and the pop-out (which passes a larger size).
 */
function renderChart(
  points: readonly FrontierPoint[],
  gutters: FrontierGutters,
  tooltip: FrontierTooltip | undefined,
  size: { width?: number; height?: number } = {},
  costAxis: FrontierCostAxis = 'blended',
): SVGSVGElement | HTMLElement {
  try {
    return points.length > 0
      ? renderFrontierSvg(points, size, gutters, tooltip, costAxis)
      : el('p', { class: 'field-hint' }, 'No models with a sourced intellect score yet.')
  } catch (err) {
    return el(
      'p',
      { class: 'field-hint' },
      `The value map failed to render: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * The two "below the chart" disclosures: scored-but-unpriced models in intellect
 * bands, and priced-but-unscored models grouped by provider. Shared so the
 * pop-out shows the same lists the inline panel does (its gutter only overlays
 * the top few on the chart itself).
 */
function buildAuxLists(
  unpricedList: readonly CanonicalScoredModel[],
  unscoredList: readonly { id: string; costPerMTok: number }[],
): HTMLElement[] {
  const out: HTMLElement[] = []
  if (unpricedList.length > 0) {
    out.push(
      el(
        'details',
        { class: 'field-hint frontier-unpriced-list' },
        el('summary', {}, `${String(unpricedList.length)} scored models with no price data yet`),
        renderBandedModelList(
          unpricedList.map((u) => ({ id: u.id, intellect: u.intellect, estimated: u.estimated })),
        ),
      ),
    )
  }
  if (unscoredList.length > UNSCORED_ROW_LIMIT) {
    out.push(
      el(
        'details',
        { class: 'field-hint frontier-unscored-list' },
        el(
          'summary',
          {},
          `${String(unscoredList.length)} priced models without an intellect score`,
        ),
        renderProviderGroupedList([...unscoredList]),
      ),
    )
  }
  return out
}

export interface IntellectFrontierPanel {
  root: HTMLFieldSetElement
  refresh: () => Promise<void>
}

/**
 * The settings panel: chart + composite footnotes, refreshed with the loaded
 * local models so on-device options appear as they become available. Renders a
 * quiet placeholder when nothing has a sourced score yet — never an invented
 * point.
 */
export interface LiveModelsFetch {
  ok: boolean
  models: LiveAaModel[]
  /** Index version the feed declared (e.g. "4.1"); gate input when present. */
  indexVersion?: string | number
  error?: string
}

export function createIntellectFrontierPanel(
  loadLocalModels: () => Promise<string[]>,
  loadExtraProviders?: () => Promise<readonly ExtraProvider[]>,
  loadLiveModels?: () => Promise<LiveModelsFetch>,
  loadPlanUsage?: () => Promise<PlanUsageSnapshot>,
): IntellectFrontierPanel {
  const chartHost = el('div', { class: 'frontier-chart' })
  const liveNotes = el('div', { class: 'field-hint frontier-live-notes' })
  const compositeHost = el('div', { class: 'frontier-composite-strip' })
  let lastPoints: FrontierPoint[] = []
  let lastGutters: FrontierGutters = {}
  // Fetched inputs, cached so the Discover toggle re-renders without refetching.
  let state: {
    localIds: string[]
    extraProviders: readonly ExtraProvider[]
    live: ReturnType<typeof liveIntellectCandidates>
    liveFetch: LiveModelsFetch
    planUsage: PlanUsageSnapshot | null
  } | null = null
  let discover = false
  let showUnpriced = false
  let zdrOnly = false
  let costAxis: FrontierCostAxis = 'blended'
  // The full lists behind the chart, cached so the pop-out can show the same
  // "below the chart" content the inline panel does.
  let lastUnpriced: readonly CanonicalScoredModel[] = []
  let lastUnscored: readonly { id: string; costPerMTok: number }[] = []
  // The open pop-out's chart host + tooltip + toggle buttons (null when closed).
  // render() repaints these in place so the pop-out's own Discover / Show
  // unpriced toggles behave exactly like the inline chart's.
  let expandChartHost: HTMLElement | null = null
  let expandTooltip: FrontierTooltip | null = null
  let expandDiscoverBtn: HTMLButtonElement | null = null
  let expandUnpricedBtn: HTMLButtonElement | null = null
  let expandZdrBtn: HTMLButtonElement | null = null
  let expandCostAxisGroup: HTMLElement | null = null

  function toggleDiscover(): void {
    discover = !discover
    render()
  }
  function toggleUnpriced(): void {
    showUnpriced = !showUnpriced
    render()
  }
  function toggleZdrOnly(): void {
    zdrOnly = !zdrOnly
    render()
  }
  function setCostAxis(next: FrontierCostAxis): void {
    if (costAxis === next) return
    costAxis = next
    render()
  }

  function syncZdrBtn(btn: HTMLButtonElement | null): void {
    if (!btn) return
    btn.textContent = 'ZDR only'
    btn.classList.toggle('active', zdrOnly)
    btn.setAttribute('aria-pressed', zdrOnly ? 'true' : 'false')
    btn.title =
      'Show only models on zero-data-retention paths (local, Fireworks, Together, OpenRouter ZDR routing, HF partner tags). Matches the Settings privacy badge — not enterprise-contract ZDR.'
  }

  function makeCostAxisGroup(): HTMLElement {
    const group = el('span', {
      class: 'frontier-cost-axis',
      role: 'group',
      'aria-label': 'Cost axis',
    })
    const blendedBtn = el(
      'button',
      {
        type: 'button',
        class: 'frontier-btn frontier-cost-axis-btn',
        'data-cost-axis': 'blended',
      },
      '$/MTok',
    )
    const taskBtn = el(
      'button',
      {
        type: 'button',
        class: 'frontier-btn frontier-cost-axis-btn',
        'data-cost-axis': 'perTask',
      },
      '$/task',
    )
    blendedBtn.addEventListener('click', () => {
      setCostAxis('blended')
    })
    taskBtn.addEventListener('click', () => {
      setCostAxis('perTask')
    })
    group.append(blendedBtn, taskBtn)
    return group
  }

  const discoverBtn = el('button', {
    type: 'button',
    class: 'frontier-btn frontier-discover',
  })
  discoverBtn.addEventListener('click', toggleDiscover)
  const unpricedBtn = el('button', {
    type: 'button',
    class: 'frontier-btn frontier-unpriced-toggle',
  })
  unpricedBtn.addEventListener('click', toggleUnpriced)
  const zdrBtn = el('button', {
    type: 'button',
    class: 'frontier-btn frontier-zdr-toggle',
  })
  zdrBtn.addEventListener('click', toggleZdrOnly)
  const costAxisGroup = makeCostAxisGroup()
  const expandBtn = el(
    'button',
    { type: 'button', class: 'frontier-btn frontier-expand' },
    'Expand',
  )
  expandBtn.addEventListener('click', () => {
    if (lastPoints.length === 0) return
    const dialog = el('dialog', { class: 'frontier-expand-dialog' })
    const close = el('button', { type: 'button', class: 'frontier-btn' }, 'Close')
    expandDiscoverBtn = el('button', {
      type: 'button',
      class: 'frontier-btn frontier-discover',
    })
    expandDiscoverBtn.addEventListener('click', toggleDiscover)
    expandUnpricedBtn = el('button', {
      type: 'button',
      class: 'frontier-btn frontier-unpriced-toggle',
    })
    expandUnpricedBtn.addEventListener('click', toggleUnpriced)
    expandZdrBtn = el('button', {
      type: 'button',
      class: 'frontier-btn frontier-zdr-toggle',
    })
    expandZdrBtn.addEventListener('click', toggleZdrOnly)
    expandCostAxisGroup = makeCostAxisGroup()
    const bigChart = el('div', { class: 'frontier-chart frontier-expand-chart' })
    expandChartHost = bigChart
    expandTooltip = createTooltipLayer(dialog)
    const closeDialog = (): void => {
      expandChartHost = null
      expandTooltip = null
      expandDiscoverBtn = null
      expandUnpricedBtn = null
      expandZdrBtn = null
      expandCostAxisGroup = null
      dialog.remove()
    }
    close.addEventListener('click', closeDialog)
    // Esc on a modal dialog fires `cancel`, not a click on Close.
    dialog.addEventListener('cancel', closeDialog)
    dialog.append(
      el(
        'div',
        { class: 'frontier-expand-controls' },
        expandCostAxisGroup,
        expandZdrBtn,
        expandDiscoverBtn,
        expandUnpricedBtn,
        close,
      ),
      bigChart,
    )
    fieldset.append(dialog)
    // Paint the pop-out (and sync its toggle buttons) from current state.
    render()
    // jsdom (tests) lacks showModal; the open attribute is the fallback.
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')
  })
  const fieldset = el(
    'fieldset',
    { class: 'frontier-fieldset' },
    el('legend', {}, 'Model value map'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Where each model sits on intellect vs price. Models on the line are the best value at their level; hover a point for how its score was derived. ',
      costAxisGroup,
      ' ',
      zdrBtn,
      ' ',
      discoverBtn,
      ' ',
      unpricedBtn,
      ' ',
      expandBtn,
    ),
    chartHost,
    el(
      'p',
      { class: 'field-hint frontier-legend' },
      'Filled accent = on the frontier · grey = dominated (better value exists at its level) · hollow ring / (~) = estimated value · faded = discoverable (set up a provider to use) · dashed ring = included in your plan — hover any point for exactly how its number was derived.',
    ),
    liveNotes,
    compositeHost,
  )
  const panelTooltip = createTooltipLayer(fieldset)

  async function refresh(): Promise<void> {
    let localIds: string[]
    try {
      localIds = await loadLocalModels()
    } catch {
      localIds = []
    }
    let extraProviders: readonly ExtraProvider[]
    try {
      extraProviders = (await loadExtraProviders?.()) ?? []
    } catch {
      extraProviders = []
    }
    let liveFetch: LiveModelsFetch
    try {
      liveFetch = (await loadLiveModels?.()) ?? { ok: true, models: [] }
    } catch {
      liveFetch = { ok: true, models: [] }
    }
    let planUsage: PlanUsageSnapshot | null
    try {
      planUsage = (await loadPlanUsage?.()) ?? null
    } catch {
      planUsage = null
    }
    // The gate: live models join ONLY when the feed's declared index version
    // matches the canonical one (when declared) AND its values agree with our
    // curated anchors — a renormalised feed must never share the axis.
    const live = liveIntellectCandidates(liveFetch.models, liveFetch.indexVersion)
    state = { localIds, extraProviders, live, liveFetch, planUsage }
    render()
  }

  // Fill the open pop-out with a large chart plus the same lists the inline
  // panel shows below its chart (so its "in the list below" gutter note is
  // accurate). A no-op when no pop-out is open.
  function paintExpanded(): void {
    if (!expandChartHost) return
    expandChartHost.replaceChildren(
      renderChart(
        lastPoints,
        lastGutters,
        expandTooltip ?? undefined,
        {
          width: 1200,
          height: 680,
        },
        costAxis,
      ),
      ...buildAuxLists(lastUnpriced, lastUnscored),
    )
  }

  function syncCostAxisGroup(group: HTMLElement | null, taskCostAvailable: boolean): void {
    if (!group) return
    group.querySelectorAll<HTMLButtonElement>('button.frontier-cost-axis-btn').forEach((btn) => {
      const axis = btn.dataset['costAxis'] === 'perTask' ? 'perTask' : 'blended'
      btn.classList.toggle('active', axis === costAxis)
      btn.setAttribute('aria-pressed', axis === costAxis ? 'true' : 'false')
      if (axis === 'perTask') {
        btn.disabled = !taskCostAvailable
        btn.title = taskCostAvailable
          ? 'Plot Artificial Analysis cost per Intelligence Index task'
          : 'Needs Artificial Analysis live data with cost-per-task'
      } else {
        btn.disabled = false
        btn.title = 'Plot blended $/MTok (80% input / 20% output)'
      }
    })
  }

  function render(): void {
    if (!state) return
    const { localIds, extraProviders, live, liveFetch, planUsage } = state
    const applyDiscover = (btn: HTMLButtonElement | null): void => {
      if (!btn) return
      btn.hidden = live.candidates.length === 0
      btn.textContent = discover ? 'Hide discoverable' : 'Discover models'
      btn.classList.toggle('active', discover)
    }
    applyDiscover(discoverBtn)
    applyDiscover(expandDiscoverBtn)
    const liveNoteParts: Array<string | HTMLElement> = []
    if (liveFetch.models.length > 0 && live.verification.verified) {
      const stale = live.verification.mismatches
      const staleNote =
        stale.length > 0
          ? ` ${String(stale.length)} curated value${stale.length === 1 ? '' : 's'} look stale next to the live feed (${stale
              .map(
                (m) =>
                  `${displayModelLabel(m.modelId)} map ${String(m.canonical)} / live ${String(m.live)}`,
              )
              .join(
                '; ',
              )}) — a maintainer can refresh them with npm run sync:intellect -- --from-api.`
          : ''
      liveNoteParts.push(
        `Live points from the Artificial Analysis API, verified against ${String(live.verification.agreeingAnchors)} curated anchors. ${INTELLECT_ATTRIBUTION}.${staleNote}`,
      )
    } else if (liveFetch.models.length > 0) {
      // The refusal is working as designed, so keep the headline calm and put
      // the diagnosis (and the maintainer command) behind a disclosure.
      const v = live.verification
      const detail: Array<string | HTMLElement> = [
        v.versionMismatch
          ? el(
              'p',
              {},
              `The feed reports index version ${v.reportedVersion ?? '?'}, but this map is drawn on the pinned canonical scale — mixing the two would make the comparison meaningless, so live data stays off until the app's data is updated to the new version.`,
            )
          : el(
              'p',
              {},
              'The feed disagrees with the reviewed scores this map is anchored to, which usually means Artificial Analysis renormalised its index or measures a different model configuration.',
            ),
      ]
      if (v.mismatches.length > 0) {
        detail.push(
          el(
            'p',
            {},
            `Diverging anchors: ${v.mismatches
              .map(
                (m) =>
                  `${displayModelLabel(m.modelId)} (map ${String(m.canonical)}, live ${String(m.live)})`,
              )
              .join('; ')}.`,
          ),
        )
      }
      detail.push(
        el(
          'p',
          {},
          'A maintainer can adopt the new data by running ',
          el('code', {}, 'npm run sync:intellect -- --from-api'),
          ' and reviewing the result.',
        ),
      )
      liveNoteParts.push(
        el(
          'details',
          {},
          el('summary', {}, 'Live Artificial Analysis data is hidden (scale check failed)'),
          ...detail,
        ),
      )
    } else if (liveFetch.error) {
      liveNoteParts.push(`Live Artificial Analysis data unavailable: ${liveFetch.error}`)
    }
    // A verified feed can also PRICE curated models we couldn't plot before
    // (curated score wins, feed contributes the cost) — but never where a
    // catalog or provider price already covers the model.
    const baseCandidates = [
      ...localFrontierCandidates(localIds),
      ...extraProviderFrontierCandidates(extraProviders),
    ]
    const coveredResolved = new Set(
      baseCandidates.map((c) => resolveIntellectModelId(c.id) ?? c.id),
    )
    const livePricedCurated = live.pricedCurated.filter(
      (c) => !coveredResolved.has(c.id) && getModelInfo(c.id) === null,
    )
    // Discovery models (uncurated live) join the frontier computation only when
    // the Discover toggle is on — so by default the map shows what the user can
    // actually route to, and the toggle overlays what they could set up.
    const discoveryCandidates = discover ? live.candidates : []
    // Live AA cost-per-task attaches to curated catalog models too (the feed
    // otherwise only prices models missing from the catalog).
    const costPerTaskById = new Map<string, number>()
    for (const m of liveFetch.models) {
      if (typeof m.costPerTask !== 'number' || !(m.costPerTask > 0)) continue
      const key = resolveIntellectModelId(m.id) ?? m.id
      if (!costPerTaskById.has(key)) costPerTaskById.set(key, m.costPerTask)
    }
    const enrichTaskCost = (c: FrontierCandidate): FrontierCandidate => {
      if (typeof c.costPerTask === 'number' && c.costPerTask > 0) return c
      const key = resolveIntellectModelId(c.id) ?? c.id
      const task = costPerTaskById.get(key)
      return typeof task === 'number' ? { ...c, costPerTask: task } : c
    }
    // Re-price each model against the live plan snapshot: a plan-covered model
    // drops to $0 (best price → wins the frontier) with a plan badge; a model
    // whose plan window is spent keeps its real price and carries a
    // limit-reached note. Applied per grouped identity inside the frontier.
    const blendedPoints = frontierForKnownModels(
      [...baseCandidates, ...livePricedCurated, ...discoveryCandidates],
      (c) => applyPlanCoverage(enrichTaskCost(c), planUsage),
    )
    const taskCostAvailable = blendedPoints.some(
      (p) => typeof p.costPerTask === 'number' && p.costPerTask > 0,
    )
    // If the task axis has no data, fall back so the chart never goes blank.
    if (costAxis === 'perTask' && !taskCostAvailable) costAxis = 'blended'
    syncCostAxisGroup(costAxisGroup, taskCostAvailable)
    syncCostAxisGroup(expandCostAxisGroup, taskCostAvailable)
    let allPoints: FrontierPoint[]
    let missingTaskCost = 0
    if (costAxis === 'perTask') {
      const { plotted, missingAxisCost } = projectOntoCostAxis(
        blendedPoints.map(asFrontierCandidate),
        'perTask',
      )
      allPoints = computeParetoFrontier(plotted)
      missingTaskCost = missingAxisCost.length
    } else {
      allPoints = blendedPoints
    }
    syncZdrBtn(zdrBtn)
    syncZdrBtn(expandZdrBtn)
    // ZDR filter matches Settings privacy badges (local + zero-retention paths).
    // Recompute dominance after filtering so the frontier isn't polluted by
    // retained-by-default Anthropic/OpenAI points that were just hidden.
    let hiddenByZdr = 0
    if (zdrOnly) {
      const kept = allPoints.filter((p) =>
        isZeroRetentionModelPath(p.id, {
          ...(p.local === true ? { local: true } : {}),
          providers: extraProviders,
        }),
      )
      hiddenByZdr = allPoints.length - kept.length
      allPoints = computeParetoFrontier(kept.map(asFrontierCandidate))
    }
    // A verified feed can carry a hundred-plus priced models; the map's job is
    // the frontier, so dominated LIVE points collapse into a disclosure rather
    // than each claiming a labelled dot. Curated/local/provider points always
    // plot — the user chose to hold those. Dropping dominated points cannot
    // change the frontier.
    const liveIds = new Set(discoveryCandidates.map((c) => c.id))
    const dominatedLive = allPoints.filter((p) => liveIds.has(p.id) && !p.onFrontier)
    const points = allPoints.filter((p) => !liveIds.has(p.id) || p.onFrontier)
    const plottedIds = new Set(points.map((p) => resolveIntellectModelId(p.id) ?? p.id))
    const unpricedModels = unpricedCanonicalModels(plottedIds, live.hintOnly).filter(
      (u) => !zdrOnly || isZeroRetentionModelPath(u.id, { providers: extraProviders }),
    )
    lastPoints = points
    // The unpriced gutter is off by default (it can carry hundreds); the toggle
    // overlays the top few on the left axis, the full set stays in the list.
    const applyUnpriced = (btn: HTMLButtonElement | null): void => {
      if (!btn) return
      btn.hidden = unpricedModels.length === 0
      btn.textContent = showUnpriced ? 'Hide unpriced' : 'Show unpriced'
      btn.classList.toggle('active', showUnpriced)
    }
    applyUnpriced(unpricedBtn)
    applyUnpriced(expandUnpricedBtn)
    const unscoredAll = unscoredPricedModels(extraProviders)
    lastGutters = {
      ...(showUnpriced ? { unpriced: unpricedModels } : {}),
      unscored: zdrOnly
        ? unscoredAll.filter((u) => isZeroRetentionModelPath(u.id, { providers: extraProviders }))
        : unscoredAll,
    }
    // When discovery is OFF, tell the user how many models the toggle reveals.
    if (!discover && live.candidates.length > 0) {
      liveNoteParts.push(
        el(
          'span',
          {},
          `${String(live.candidates.length)} more models are available via Artificial Analysis — press “Discover models” to overlay where they'd sit on your frontier. `,
        ),
      )
    }
    if (costAxis === 'perTask' && missingTaskCost > 0) {
      liveNoteParts.push(
        el(
          'span',
          {},
          `${String(missingTaskCost)} model${missingTaskCost === 1 ? '' : 's'} lack AA task-cost data and are hidden on this axis. `,
        ),
      )
    }
    if (zdrOnly && hiddenByZdr > 0) {
      liveNoteParts.push(
        el(
          'span',
          {},
          `ZDR only: hiding ${String(hiddenByZdr)} model${hiddenByZdr === 1 ? '' : 's'} on retained-by-default paths (Anthropic/OpenAI API, …). `,
        ),
      )
    }
    if (zdrOnly && points.length === 0) {
      liveNoteParts.push(
        el(
          'span',
          {},
          'No zero-retention models on this map yet — add a Fireworks/Together provider, an HF model pinned to a ZDR partner, a local model, or OpenRouter under default ZDR routing. ',
        ),
      )
    }
    if (discover && dominatedLive.length > 0) {
      liveNoteParts.push(
        el(
          'details',
          { class: 'frontier-dominated-live' },
          el(
            'summary',
            {},
            `${String(dominatedLive.length)} discoverable models are dominated (not worth setting up — better value already on your frontier)`,
          ),
          renderBandedModelList(
            dominatedLive.map((p) => ({
              id: p.id,
              intellect: p.intellect,
              estimated: p.intellectEstimated,
              costPerMTok: p.costPerMTok,
            })),
          ),
        ),
      )
    }
    const unscoredList = lastGutters.unscored ?? []
    // The disclosure lists the FULL unpriced set regardless of the gutter
    // toggle (the gutter only overlays the top few on the chart).
    const unpricedList = unpricedModels
    lastUnpriced = unpricedList
    lastUnscored = unscoredList
    chartHost.replaceChildren(
      renderChart(points, lastGutters, panelTooltip, {}, costAxis),
      ...buildAuxLists(unpricedList, unscoredList),
    )
    // Repaint the pop-out from the same freshly computed data (no-op if closed).
    paintExpanded()
    liveNotes.replaceChildren(
      ...liveNoteParts.map((t) => (typeof t === 'string' ? el('span', {}, `${t} `) : t)),
    )
    const compositeModels = compositeScoredLocalModels(localIds)
    compositeHost.replaceChildren(
      ...(compositeModels.length > 0
        ? [
            el(
              'p',
              { class: 'field-hint' },
              'Local models without an index measurement, on their own composite scale ' +
                '(copse-intellect-v1, from their sourced benchmark axes — not comparable with the intellect axis above):',
            ),
            renderCompositeStrip(compositeModels),
          ]
        : []),
    )
  }

  return { root: fieldset, refresh }
}
