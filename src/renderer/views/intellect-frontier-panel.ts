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
import {
  extraProviderFrontierCandidates,
  localFrontierCandidates,
  openRouterFrontierCandidates,
  type OpenRouterPricedModel,
} from '@copse/llm/frontier-candidates.ts'
import { TRACKED_MODELS, cloudModelDisplayLabel, getModelInfo } from '@copse/llm/model-catalog.ts'
import { parseModelSelection } from '@copse/llm/model-selection.ts'
import { requestModelCards, resolvedModelCard } from './model-card-cache.ts'
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
import { getLocalModelCapability } from '@copse/llm/local-model-catalog.ts'
import { isNoTrainingModelPath, isZeroRetentionModelPath } from '@copse/llm/data-policies.ts'
import type { PlanUsageSnapshot } from '@copse/plan-usage'
import { applyPlanCoverage, type PlanCoverageMode } from '@shared/plan-inclusion.ts'
import { el } from '../dom/helpers.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'

const WIDTH = 460
const HEIGHT = 290
// A tight right margin: labels no longer need a wide reserved gutter because a
// point near the right edge flips its label to the left (see the label
// placement below), so the plot itself claims almost the full panel width.
const MARGIN = { top: 14, right: 20, bottom: 34, left: 40 }

/** Clearance kept between a lifted frontier label and the frontier line. */
const LABEL_LINE_GAP = 3

/** Card links warmed per render. Matches the `modelCards:resolve` batch cap. */
const MAX_CARD_PREFETCH = 128

/**
 * Compact display form of a model id for chart labels: provider prefixes and
 * vendor org paths are wrappers, not identity, so `huggingface:zai-org/
 * GLM-5.2:deepinfra` reads as `GLM-5.2:deepinfra`. Tooltips keep the full id.
 */
export function displayModelLabel(id: string): string {
  const resolved = resolveIntellectModelId(id)
  if (resolved !== null && TRACKED_MODELS.some((tracked) => tracked === resolved)) {
    return cloudModelDisplayLabel(resolved)
  }
  let s = resolved ?? id
  const sep = s.indexOf(':')
  if (sep > 0 && !s.slice(0, sep).includes('/')) s = s.slice(sep + 1)
  const slash = s.lastIndexOf('/')
  if (slash >= 0) s = s.slice(slash + 1)
  return cloudModelDisplayLabel(s || id)
}

/** Rough label width for collision purposes (9px font ≈ 5.2px/char). */
function approxLabelWidth(text: string): number {
  return 10 + text.length * 5.2
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
  ...children: (Node | string)[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  node.append(...children)
  return node
}

export type { OpenRouterPricedModel }
export { extraProviderFrontierCandidates, localFrontierCandidates, openRouterFrontierCandidates }

export interface OpenRouterFrontierSource {
  models: readonly OpenRouterPricedModel[]
  zdrOnly: boolean
  allowTraining: boolean
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
  })

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

/**
 * Append the "Card" section: a link to the vendor's own model card / system
 * card for this model. Nothing is appended unless a card has RESOLVED — an
 * absent or still-resolving card reads as absent, never as a placeholder link
 * that 404s. `wireTooltip` repaints the hover card when an answer lands.
 *
 * The anchor opens externally: an `http(s)` `target="_blank"` inside the
 * renderer is denied by the web-contents lockdown and handed to
 * `shell.openExternal`, so the card opens in the user's browser without this
 * panel needing an IPC client.
 */
function appendCardSection(root: HTMLElement, id: string): void {
  const card = resolvedModelCard(id)
  if (!card) return
  root.append(
    ttRow('tt-section', 'Card'),
    ttRow(
      'tt-line',
      el(
        'a',
        {
          class: 'tt-card-link',
          href: card.url,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        card.title,
      ),
    ),
  )
  if (card.kind === 'index') {
    root.append(
      ttRow('tt-muted', `${card.publisher} publishes this model's card behind their card index.`),
    )
  }
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
    if (p.planDetail.priorLimitHits) {
      const { hit, total } = p.planDetail.priorLimitHits
      root.append(
        ttRow(
          'tt-muted',
          `Limit hit in ${String(hit)}/${String(total)} prior windows — still treating as included.`,
        ),
      )
    }
  }
  // Plan window spent: it's plotted at its real price now, not as included.
  if (p.planLimitReached) {
    const prior = p.planLimitReached.priorLimitHits
    const priorNote = prior
      ? ` Limit hit in ${String(prior.hit)}/${String(prior.total)} prior windows.`
      : ''
    root.append(
      ttRow(
        'tt-muted',
        prior
          ? `${p.planLimitReached.label} usually exhausted — plotted at off-plan price.${priorNote}`
          : `${p.planLimitReached.label} plan limit reached${formatReset(p.planLimitReached.resetsAt)} — plotted at its off-plan price.`,
      ),
    )
  }

  appendCardSection(root, p.id)

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
  appendCardSection(root, u.id)
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
  appendCardSection(root, u.id)
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

/**
 * How long the hover card survives after the pointer leaves its point. The card
 * carries a model-card link, so it has to be reachable: the pointer needs to
 * cross the {@link TOOLTIP_OFFSET_PX} gap between point and card, and during
 * that crossing it is over neither. Entering the card cancels the pending hide.
 */
export const TOOLTIP_HIDE_GRACE_MS = 220

/** A positioned hover layer inside `container` (which must be a positioning context). */
export function createTooltipLayer(container: HTMLElement): FrontierTooltip {
  const tip = el('div', { class: 'frontier-tooltip', hidden: true })
  container.append(tip)
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  const cancelHide = (): void => {
    if (hideTimer !== undefined) clearTimeout(hideTimer)
    hideTimer = undefined
  }
  const hideNow = (): void => {
    cancelHide()
    tip.hidden = true
  }
  tip.addEventListener('mouseenter', cancelHide)
  tip.addEventListener('mouseleave', hideNow)
  return {
    show(content, evt): void {
      cancelHide()
      tip.replaceChildren(content)
      tip.hidden = false
      positionFrontierTooltip(tip, container, evt)
    },
    hide(): void {
      // Deferred, not immediate: see TOOLTIP_HIDE_GRACE_MS.
      cancelHide()
      hideTimer = setTimeout(hideNow, TOOLTIP_HIDE_GRACE_MS)
    },
  }
}

/**
 * The API used to resolve card links, set once by the panel. A module-level
 * handle because `wireTooltip` is called from the pure SVG renderer, which has
 * no business taking an IPC client as a parameter. Undefined in unit tests and
 * in the demo build, where nothing is resolved and no card section renders.
 */
let modelCardApi: ModelCardResolveApi | undefined

export type ModelCardResolveApi = Parameters<typeof requestModelCards>[1]

/** Point the panel's card lookups at an IPC bridge. */
export function setModelCardApi(api: ModelCardResolveApi | undefined): void {
  modelCardApi = api
}

function wireTooltip(
  target: SVGElement,
  tooltip: FrontierTooltip | undefined,
  build: () => HTMLElement,
  modelId?: string,
): void {
  if (!tooltip) return
  // Resolving a card is a round-trip, so the first hover can open before the
  // answer exists. Repaint once it lands — but only while the pointer is still
  // on this point, or a stale reply would reopen a card the user has left.
  let hovering = false
  let lastEvent: MouseEvent | null = null
  const fillCard = (): void => {
    if (modelId === undefined) return
    void requestModelCards([modelId], modelCardApi).then((landed) => {
      if (!landed || !hovering || !lastEvent) return
      tooltip.show(build(), lastEvent)
    })
  }
  target.addEventListener('mouseenter', (evt) => {
    hovering = true
    lastEvent = evt
    tooltip.show(build(), evt)
    fillCard()
  })
  target.addEventListener('mousemove', (evt) => {
    lastEvent = evt
    tooltip.show(build(), evt)
  })
  target.addEventListener('mouseleave', () => {
    hovering = false
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
  })

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
      'intellect',
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

  // Frontier line as x-sorted segments, so a label sitting beside a frontier
  // point can be lifted clear of the segment that would otherwise run through it.
  const frontierByX = [...frontier].sort((a, b) => x(a.costPerMTok) - x(b.costPerMTok))
  /** Screen-y span the frontier line occupies across [xa, xb], or null if none. */
  const frontierYRange = (xa: number, xb: number): { min: number; max: number } | null => {
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i + 1 < frontierByX.length; i++) {
      const a = frontierByX[i]
      const b = frontierByX[i + 1]
      if (!a || !b) continue
      const ax = x(a.costPerMTok)
      const bx = x(b.costPerMTok)
      const lo = Math.max(xa, ax)
      const hi = Math.min(xb, bx)
      if (lo > hi) continue
      const ay = y(a.intellect)
      const by = y(b.intellect)
      const span = bx - ax || 1
      const y0 = ay + ((by - ay) * (lo - ax)) / span
      const y1 = ay + ((by - ay) * (hi - ax)) / span
      min = Math.min(min, y0, y1)
      max = Math.max(max, y0, y1)
    }
    return min === Infinity ? null : { min, max }
  }

  // Direct labels sit beside their point, in compact display form (full ids
  // stay in the tooltip). Collision layout is interval-aware: a label bumps
  // down until its horizontal extent overlaps nothing on its row. Frontier
  // points are placed FIRST so they win the room; a label that can only land
  // below the plot is DROPPED (the point stays hover-only) so the cascade can
  // never overflow the axis into the copy below. A label whose natural right
  // placement would run off the (now tight) right edge FLIPS to the left of its
  // point instead, so the trimmed margin never clips it.
  // Frontier labels lift UP to clear the line, so they are placed bottom-first
  // (each rises into space the lower ones haven't claimed); the rest cascade
  // DOWN, so they are placed top-first.
  const labelledPoints = [...points].sort(
    (a, b) =>
      Number(b.onFrontier) - Number(a.onFrontier) ||
      (a.onFrontier ? y(b.intellect) - y(a.intellect) : y(a.intellect) - y(b.intellect)),
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
    // A frontier point sits ON the line, so the adjacent segment can run through
    // its side label. When it does, lift the label clear ABOVE the line — the
    // Pareto-empty upper region — rather than leave the line crossing the text.
    const up = p.onFrontier
    if (up) {
      const range = frontierYRange(x0, x1)
      // Text band is roughly [py - 8, py + 2] (9px glyphs above the baseline).
      if (range && py - 8 < range.max + LABEL_LINE_GAP && py + 2 > range.min - LABEL_LINE_GAP) {
        py = range.min - LABEL_LINE_GAP
      }
    }
    // Nudge off other labels and dots. Frontier labels move UP into clear space,
    // the rest move DOWN, so neither is pushed back through the frontier line.
    // The strict-progress guard (a move must change py in the chosen direction)
    // avoids a floating-point fixed point where the step is a no-op yet `moved`
    // stays true forever.
    let moved = true
    while (moved) {
      moved = false
      for (const prev of placed) {
        if (Math.abs(py - prev.py) >= 10 || x0 >= prev.x1 || x1 <= prev.x0) continue
        const next = up ? prev.py - 10 : prev.py + 10
        if (up ? next < py : next > py) {
          py = next
          moved = true
        }
      }
    }
    if (up) {
      // Keep a lifted frontier label inside the plot rather than dropping it.
      if (py - 8 < MARGIN.top) py = MARGIN.top + 8
    } else if (py > plotBottom) {
      // Drop a label that can only land below the plot — hover still has it.
      continue
    }
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
          'data-model-id': p.id,
        })
      : svgEl('circle', {
          cx,
          cy,
          r: '5',
          fill: emphasis,
          ...(p.discovery ? { opacity: '0.55' } : {}),
          class: cls,
          'data-model-id': p.id,
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
    const hit = svgEl('circle', {
      cx,
      cy,
      r: '11',
      fill: 'transparent',
      class: 'frontier-hit',
      'data-model-id': p.id,
    })
    if (tooltip) wireTooltip(hit, tooltip, () => pointTooltipContent(p, costAxis), p.id)
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
        wireTooltip(dot, tooltip, () => unpricedTooltipContent(u), u.id)
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
        wireTooltip(dot, tooltip, () => unscoredTooltipContent(u), u.id)
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
 * The chart key. Each entry draws the same mark the chart draws, so a reader
 * matches shape to shape instead of decoding a sentence of prose.
 */
export function renderFrontierKey(): HTMLElement {
  // Swatches are CSS-drawn spans, not <svg>: the key sits in the same subtree
  // tests scan for the chart, and a second svg there would be ambiguous.
  const entries: Array<[string, string]> = [
    ['frontier', 'Best value at its level'],
    ['dominated', 'Another model gives more for the money'],
    ['estimated', 'Score is an estimate'],
    ['discovery', 'Available once you set it up'],
    ['plan', 'Included in your plan'],
  ]
  return el(
    'ul',
    { class: 'field-hint frontier-key' },
    ...entries.map(([mark, label]) =>
      el(
        'li',
        { class: 'frontier-key-item' },
        el('span', { class: 'frontier-key-swatch', 'data-mark': mark }),
        label,
      ),
    ),
  )
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
  /** Switch plan re-pricing for the value map (Plan / Inference / Expected). */
  setPlanCoverageMode: (mode: PlanCoverageMode) => void
  getPlanCoverageMode: () => PlanCoverageMode
  /** Feed completed-window exhaustion rates for Expected plan mode. */
  setWindowExhaustion: (rates: ReadonlyMap<string, { hit: number; total: number }>) => void
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
  loadOpenRouter?: () => Promise<OpenRouterFrontierSource>,
  /**
   * The model selections the real picker currently offers. Absent preserves
   * the standalone/test helper's catalog-wide behaviour; production supplies
   * this so the default map never advertises an unavailable route.
   */
  loadRoutableModelSelections?: () => Promise<readonly string[]>,
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
    openRouter: OpenRouterFrontierSource
    routableSelections: readonly string[] | null
  } | null = null
  let discover = false
  let showUnpriced = false
  let zdrOnly = false
  let noTrainingOnly = false
  let costAxis: FrontierCostAxis = 'blended'
  let planCoverageMode: PlanCoverageMode = 'plan'
  let windowExhaustion: ReadonlyMap<string, { hit: number; total: number }> = new Map()
  let expandPlanCoverageGroup: HTMLElement | null = null
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
  let expandNoTrainingBtn: HTMLButtonElement | null = null
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
  function toggleNoTrainingOnly(): void {
    noTrainingOnly = !noTrainingOnly
    render()
  }
  function setCostAxis(next: FrontierCostAxis): void {
    if (costAxis === next) return
    costAxis = next
    render()
  }
  function setPlanCoverageMode(next: PlanCoverageMode): void {
    if (planCoverageMode === next) return
    planCoverageMode = next
    render()
  }
  function setWindowExhaustion(rates: ReadonlyMap<string, { hit: number; total: number }>): void {
    windowExhaustion = rates
    if (planCoverageMode === 'expected') render()
  }

  function syncZdrBtn(btn: HTMLButtonElement | null): void {
    if (!btn) return
    btn.textContent = 'ZDR only'
    btn.classList.toggle('active', zdrOnly)
    btn.setAttribute('aria-pressed', zdrOnly ? 'true' : 'false')
    btn.title =
      'Show only models on zero-data-retention paths (local, Fireworks, Together, OpenRouter ZDR routing, HF partner tags). Matches the Settings privacy badge — not enterprise-contract ZDR.'
  }

  function syncNoTrainingBtn(btn: HTMLButtonElement | null): void {
    if (!btn) return
    btn.textContent = 'No training'
    btn.classList.toggle('active', noTrainingOnly)
    btn.setAttribute('aria-pressed', noTrainingOnly ? 'true' : 'false')
    btn.title =
      'Show only routes known not to train on prompts. Includes local, ZDR, and retained-but-no-training providers; unknown policies are hidden.'
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

  function makePlanCoverageGroup(): HTMLElement {
    const group = el('span', {
      class: 'frontier-cost-axis frontier-plan-coverage',
      role: 'group',
      'aria-label': 'Plan cost basis',
    })
    const modes: Array<{ mode: PlanCoverageMode; label: string; title: string }> = [
      {
        mode: 'plan',
        label: 'Plan',
        title: 'Re-price subscription-included models at $0 while their window has headroom',
      },
      {
        mode: 'inference',
        label: 'Inference',
        title: 'Ignore the plan — plot every cloud model at catalog API $/MTok',
      },
      {
        mode: 'expected',
        label: 'Expected',
        title:
          'Use prior window history: if a binding window usually hits its limit, plot at API price',
      },
    ]
    for (const { mode, label, title } of modes) {
      const btn = el(
        'button',
        {
          type: 'button',
          class: 'frontier-btn frontier-cost-axis-btn',
          'data-plan-coverage': mode,
          title,
        },
        label,
      )
      btn.addEventListener('click', () => {
        setPlanCoverageMode(mode)
      })
      group.append(btn)
    }
    return group
  }

  function syncPlanCoverageGroup(group: HTMLElement | null): void {
    if (!group) return
    for (const btn of group.querySelectorAll<HTMLButtonElement>('[data-plan-coverage]')) {
      const mode = btn.dataset['planCoverage']
      const active = mode === planCoverageMode
      btn.classList.toggle('active', active)
      btn.setAttribute('aria-pressed', active ? 'true' : 'false')
    }
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
  const noTrainingBtn = el('button', {
    type: 'button',
    class: 'frontier-btn frontier-no-training-toggle',
  })
  noTrainingBtn.addEventListener('click', toggleNoTrainingOnly)
  const costAxisGroup = makeCostAxisGroup()
  const planCoverageGroup = makePlanCoverageGroup()
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
    expandNoTrainingBtn = el('button', {
      type: 'button',
      class: 'frontier-btn frontier-no-training-toggle',
    })
    expandNoTrainingBtn.addEventListener('click', toggleNoTrainingOnly)
    expandCostAxisGroup = makeCostAxisGroup()
    expandPlanCoverageGroup = makePlanCoverageGroup()
    const bigChart = el('div', { class: 'frontier-chart frontier-expand-chart' })
    expandChartHost = bigChart
    expandTooltip = createTooltipLayer(dialog)
    const closeDialog = (): void => {
      expandChartHost = null
      expandTooltip = null
      expandDiscoverBtn = null
      expandUnpricedBtn = null
      expandZdrBtn = null
      expandNoTrainingBtn = null
      expandCostAxisGroup = null
      expandPlanCoverageGroup = null
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
        expandPlanCoverageGroup,
        expandZdrBtn,
        expandNoTrainingBtn,
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
      'Where each model sits on intellect vs price. Models on the line are the best value at their level; hover a point for how its score was derived.',
    ),
    el(
      'div',
      { class: 'frontier-controls' },
      el('span', { class: 'frontier-control-group' }, costAxisGroup),
      el('span', { class: 'frontier-control-group' }, planCoverageGroup),
      el('span', { class: 'frontier-control-group' }, zdrBtn, noTrainingBtn),
      el('span', { class: 'frontier-control-group' }, discoverBtn, unpricedBtn, expandBtn),
    ),
    chartHost,
    renderFrontierKey(),
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
    let openRouter: OpenRouterFrontierSource
    try {
      openRouter = (await loadOpenRouter?.()) ?? {
        models: [],
        zdrOnly: true,
        allowTraining: false,
      }
    } catch {
      openRouter = { models: [], zdrOnly: true, allowTraining: false }
    }
    let routableSelections: readonly string[] | null = null
    if (loadRoutableModelSelections) {
      try {
        routableSelections = await loadRoutableModelSelections()
      } catch {
        // Fail closed: a picker load failure must not turn the static catalog
        // into a list of models that only look available.
        routableSelections = []
      }
    }
    // The gate: live models join ONLY when the feed's declared index version
    // matches the canonical one (when declared) AND its values agree with our
    // curated anchors — a renormalised feed must never share the axis.
    const live = liveIntellectCandidates(liveFetch.models, liveFetch.indexVersion)
    state = {
      localIds,
      extraProviders,
      live,
      liveFetch,
      planUsage,
      openRouter,
      routableSelections,
    }
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
    const { localIds, extraProviders, live, liveFetch, planUsage, openRouter, routableSelections } =
      state
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
      ...openRouterFrontierCandidates(openRouter.models),
    ]
    const exactRoutes = routableSelections === null ? null : new Set(routableSelections)
    const delegatedModelIds = new Set<string>()
    const routableModelIds = new Set<string>()
    for (const selection of routableSelections ?? []) {
      const resolved = resolveIntellectModelId(selection)
      if (resolved !== null) routableModelIds.add(resolved)
      const namespace = parseModelSelection(selection).namespace
      if (namespace !== 'acp' && namespace !== 'remote-agent' && namespace !== 'plugin-model') {
        continue
      }
      if (resolved !== null) delegatedModelIds.add(resolved)
    }
    const modelIdentityHasRoute = (id: string): boolean => {
      if (exactRoutes === null) return true
      const resolved = resolveIntellectModelId(id) ?? id
      return routableModelIds.has(resolved)
    }
    const isTrackedCloudCandidate = (candidate: FrontierCandidate): boolean =>
      TRACKED_MODELS.some((id) => id === candidate.id)
    const candidateHasRoute = (candidate: FrontierCandidate): boolean => {
      if (exactRoutes === null) return true
      if (exactRoutes.has(candidate.id)) return true
      if (candidate.local === true && exactRoutes.has(`lmstudio:${candidate.id}`)) return true
      if (!isTrackedCloudCandidate(candidate)) return false
      const resolved = resolveIntellectModelId(candidate.id) ?? candidate.id
      return delegatedModelIds.has(resolved)
    }
    const routableBaseCandidates = baseCandidates.filter(candidateHasRoute)
    const coveredResolved = new Set(
      routableBaseCandidates.map((c) => resolveIntellectModelId(c.id) ?? c.id),
    )
    const livePricedCurated = live.pricedCurated.filter(
      (c) => !coveredResolved.has(c.id) && getModelInfo(c.id) === null,
    )
    // A reviewed score does not make a model routable. The full AA sync curates
    // hundreds of measurements, so a priced curated row with no catalog or
    // configured-provider route is still a discovery opportunity. Keeping it
    // behind the same toggle prevents historical/configuration variants from
    // flooding the default map; dominated discoveries collapse below, so an
    // expensive legacy model cannot stretch the price axis either.
    const liveDiscoverableCandidates: FrontierCandidate[] = [
      ...live.candidates,
      ...livePricedCurated.map((candidate) => ({ ...candidate, discovery: true })),
    ]
    const trackedDiscoverableCandidates: FrontierCandidate[] = []
    if (exactRoutes !== null) {
      for (const id of TRACKED_MODELS) {
        const info = getModelInfo(id)
        const score = getIntellectScore(id)
        if (!info || !score) continue
        const candidate: FrontierCandidate = {
          id,
          intellect: score.value,
          intellectEstimated: score.estimated === true,
          costPerMTok: blendedPricePerMTok(info),
          discovery: true,
        }
        if (!candidateHasRoute(candidate)) trackedDiscoverableCandidates.push(candidate)
      }
    }
    const discoverableCandidates = [...liveDiscoverableCandidates, ...trackedDiscoverableCandidates]
    const applyDiscover = (btn: HTMLButtonElement | null): void => {
      if (!btn) return
      btn.hidden = discoverableCandidates.length === 0
      btn.textContent = discover ? 'Hide discoverable' : 'Discover models'
      btn.classList.toggle('active', discover)
      btn.setAttribute('aria-pressed', discover ? 'true' : 'false')
    }
    applyDiscover(discoverBtn)
    applyDiscover(expandDiscoverBtn)
    // Discovery models join the frontier computation only when requested — by
    // default the map shows models the user can actually route to.
    // Tracked catalog models are already supplied by frontierForKnownModels;
    // only live/feed discoveries need to join the extra-candidate list here.
    const discoveryCandidates = discover ? liveDiscoverableCandidates : []
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
    const allRouteCandidates = [...baseCandidates, ...discoveryCandidates]
    const trackedCandidateIsDiscovery = (candidate: FrontierCandidate): boolean =>
      exactRoutes !== null && isTrackedCloudCandidate(candidate) && !candidateHasRoute(candidate)
    const candidateIsIncluded = (candidate: FrontierCandidate): boolean =>
      candidateHasRoute(candidate) ||
      candidate.discovery === true ||
      (discover && trackedCandidateIsDiscovery(candidate))
    const adjustCandidate = (candidate: FrontierCandidate): FrontierCandidate => {
      const surfaced = trackedCandidateIsDiscovery(candidate)
        ? { ...candidate, discovery: true }
        : candidate
      const enriched = enrichTaskCost(surfaced)
      // A setup opportunity is not covered by a route the user owns today,
      // even if a broad subscription snapshot mentions the same family.
      return enriched.discovery === true
        ? enriched
        : applyPlanCoverage(enriched, planUsage, {
            mode: planCoverageMode,
            windowExhaustion,
          })
    }
    const routePolicy = {
      providers: extraProviders,
      openRouterZdrOnly: openRouter.zdrOnly,
      openRouterAllowTraining: openRouter.allowTraining,
    }
    const routeAllowed = (candidate: FrontierCandidate): boolean => {
      const local = candidate.local === true
      if (
        zdrOnly &&
        !isZeroRetentionModelPath(candidate.id, {
          ...routePolicy,
          ...(local ? { local: true } : {}),
        })
      ) {
        return false
      }
      return (
        !noTrainingOnly ||
        isNoTrainingModelPath(candidate.id, {
          ...routePolicy,
          ...(local ? { local: true } : {}),
        })
      )
    }
    const unfilteredBlendedPoints = frontierForKnownModels(
      allRouteCandidates,
      adjustCandidate,
      candidateIsIncluded,
    )
    const privacyBlendedPoints =
      zdrOnly || noTrainingOnly
        ? frontierForKnownModels(
            allRouteCandidates,
            adjustCandidate,
            (candidate) => candidateIsIncluded(candidate) && routeAllowed(candidate),
          )
        : unfilteredBlendedPoints
    const hiddenByZdr = zdrOnly
      ? unfilteredBlendedPoints.length -
        frontierForKnownModels(
          allRouteCandidates,
          adjustCandidate,
          (candidate) =>
            candidateIsIncluded(candidate) &&
            isZeroRetentionModelPath(candidate.id, {
              ...routePolicy,
              ...(candidate.local === true ? { local: true } : {}),
            }),
        ).length
      : 0
    const hiddenByNoTraining = noTrainingOnly
      ? unfilteredBlendedPoints.length -
        frontierForKnownModels(
          allRouteCandidates,
          adjustCandidate,
          (candidate) =>
            candidateIsIncluded(candidate) &&
            isNoTrainingModelPath(candidate.id, {
              ...routePolicy,
              ...(candidate.local === true ? { local: true } : {}),
            }),
        ).length
      : 0
    const blendedPoints = privacyBlendedPoints
    const taskCostAvailable = blendedPoints.some(
      (p) => typeof p.costPerTask === 'number' && p.costPerTask > 0,
    )
    // If the task axis has no data, fall back so the chart never goes blank.
    if (costAxis === 'perTask' && !taskCostAvailable) costAxis = 'blended'
    syncCostAxisGroup(costAxisGroup, taskCostAvailable)
    syncCostAxisGroup(expandCostAxisGroup, taskCostAvailable)
    syncPlanCoverageGroup(planCoverageGroup)
    syncPlanCoverageGroup(expandPlanCoverageGroup)
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
    syncNoTrainingBtn(noTrainingBtn)
    syncNoTrainingBtn(expandNoTrainingBtn)
    // Discovery can carry a hundred-plus priced models; the map's job is the
    // frontier, so dominated setup opportunities collapse into a disclosure
    // rather than each claiming a labelled dot. Dropping dominated points
    // cannot change the frontier.
    const dominatedLive = allPoints.filter((p) => p.discovery === true && !p.onFrontier)
    const points = allPoints.filter((p) => p.discovery !== true || p.onFrontier)
    // Discoverable points are deliberately absent from the default chart, but
    // the feed still supplied their price. Exclude them from the "no price"
    // disclosure without pretending they are routable or plotting them. Use
    // the blended-price candidates rather than the current projected points:
    // a model missing AA task cost is still priced and belongs in the task-axis
    // note, not the generic no-price list.
    const pricedIds = new Set(
      [...blendedPoints, ...discoverableCandidates].map(
        (p) => resolveIntellectModelId(p.id) ?? p.id,
      ),
    )
    const unpricedModels = unpricedCanonicalModels(pricedIds, live.hintOnly).filter((u) => {
      if (!modelIdentityHasRoute(u.id)) return false
      if (zdrOnly && !isZeroRetentionModelPath(u.id, routePolicy)) return false
      return !noTrainingOnly || isNoTrainingModelPath(u.id, routePolicy)
    })
    lastPoints = points
    // Warm the card cache for what is plotted, so the first hover on a point
    // usually has its answer already. Fire-and-forget: nothing repaints on the
    // result — the hover path reads the cache, and repaints itself if an answer
    // arrives while a card is open. Capped to the IPC batch limit.
    void requestModelCards(
      points.slice(0, MAX_CARD_PREFETCH).map((p) => p.id),
      modelCardApi,
    )
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
    const filteredUnscored = unscoredAll.filter((model) => {
      if (
        !candidateHasRoute({
          id: model.id,
          intellect: 0,
          costPerMTok: model.costPerMTok,
        })
      ) {
        return false
      }
      if (zdrOnly && !isZeroRetentionModelPath(model.id, routePolicy)) return false
      return !noTrainingOnly || isNoTrainingModelPath(model.id, routePolicy)
    })
    lastGutters = {
      ...(showUnpriced ? { unpriced: unpricedModels } : {}),
      unscored: filteredUnscored,
    }
    // When discovery is OFF, tell the user how many models the toggle reveals.
    if (!discover && discoverableCandidates.length > 0) {
      const modelCount = discoverableCandidates.length
      liveNoteParts.push(
        el(
          'span',
          {},
          `${String(modelCount)} more priced and scored model${modelCount === 1 ? ' is' : 's are'} not currently available in your model picker — press “Discover models” to overlay where they'd sit on your frontier. `,
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
    if (noTrainingOnly && hiddenByNoTraining > 0) {
      liveNoteParts.push(
        el(
          'span',
          {},
          `No training: hiding ${String(hiddenByNoTraining)} model${hiddenByNoTraining === 1 ? '' : 's'} on training or unknown-policy routes. `,
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

  return {
    root: fieldset,
    refresh,
    setPlanCoverageMode,
    getPlanCoverageMode: () => planCoverageMode,
    setWindowExhaustion,
  }
}
