// The "model value map": a small scatter of every intellect-scored model on
// intellect (y, canonical Intelligence Index scale) vs blended price (x,
// $/MTok at the 80/20 mix), with the Pareto frontier drawn through the
// undominated points. Answers "which models are worth their price" at a
// glance; each point's native tooltip carries the full derivation
// (measurement, citation, any equating/quant adjustment) from
// `explainIntellectScore` so no number is unexplained.
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
  frontierForKnownModels,
  type FrontierCandidate,
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
import { el } from '../dom/helpers.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'

const WIDTH = 460
const HEIGHT = 230
const MARGIN = { top: 14, right: 96, bottom: 34, left: 40 }

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

function tooltipFor(point: FrontierPoint): string {
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

export function renderFrontierSvg(
  points: readonly FrontierPoint[],
  size: { width?: number; height?: number } = {},
  gutters: FrontierGutters = {},
): SVGSVGElement {
  const unpriced = gutters.unpriced ?? []
  const unscored = gutters.unscored ?? []
  const gutterW = unpriced.length > 0 ? UNPRICED_GUTTER_W : 0
  const baseHeight = size.height ?? HEIGHT
  const width = (size.width ?? WIDTH) + gutterW
  const plotW = width - gutterW - MARGIN.left - MARGIN.right
  const plotH = baseHeight - MARGIN.top - MARGIN.bottom
  const allCosts = [...points.map((p) => p.costPerMTok), ...unscored.map((u) => u.costPerMTok)]
  const allIntellects = [...points.map((p) => p.intellect), ...unpriced.map((u) => u.intellect)]
  const maxCost = Math.max(1, ...allCosts) * 1.15
  const maxIntellect = Math.max(10, ...allIntellects) + 5
  const minIntellect = Math.max(0, Math.min(...allIntellects) - 8)
  const x = (cost: number): number => MARGIN.left + (cost / maxCost) * plotW
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

  const svg = svgEl('svg', {
    viewBox: `0 0 ${String(width)} ${String(height)}`,
    role: 'img',
    'aria-label': 'Model intellect versus blended price, with the Pareto frontier',
    style: 'width:100%;height:auto;display:block',
  }) as SVGSVGElement

  // Recessive grid: a few horizontal lines only.
  for (const t of ticks(maxIntellect, 4)) {
    if (t < minIntellect) continue
    svg.append(
      svgEl('line', {
        x1: String(MARGIN.left),
        x2: String(MARGIN.left + plotW),
        y1: String(y(t)),
        y2: String(y(t)),
        stroke: 'var(--border-subtle)',
        'stroke-width': '1',
      }),
      svgEl(
        'text',
        {
          x: String(MARGIN.left - 6),
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
      x1: String(MARGIN.left),
      x2: String(MARGIN.left + plotW),
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
        x: String(MARGIN.left + plotW / 2),
        y: String(height - 4),
        'text-anchor': 'middle',
        'font-size': '9',
        fill: 'var(--text-secondary)',
      },
      'blended price, $/MTok (80% in / 20% out) — local models plot at $0',
    ),
    svgEl(
      'text',
      {
        x: '10',
        y: String(MARGIN.top + plotH / 2),
        transform: `rotate(-90 10 ${String(MARGIN.top + plotH / 2)})`,
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

  // Direct labels sit right of their point, in compact display form (full ids
  // stay in the tooltip). Collision layout is interval-aware: a label bumps
  // down until its horizontal extent overlaps nothing on its row.
  // Deterministic: processed in y order.
  // On a crowded chart only frontier points keep labels — the rest stay
  // hover-only so the label cascade cannot outgrow the plot.
  const labelledPoints = points.length > 28 ? points.filter((p) => p.onFrontier) : [...points]
  const labelText = new Map<string, string>()
  const labelY = new Map<string, number>()
  // Dots are obstacles too — a label must not sit under another point's mark.
  const placed: Array<{ x0: number; x1: number; py: number }> = points.map((p) => ({
    x0: x(p.costPerMTok) - 7,
    x1: x(p.costPerMTok) + 7,
    py: y(p.intellect) + 3,
  }))
  for (const p of labelledPoints.sort((a, b) => y(a.intellect) - y(b.intellect))) {
    const text = `${displayModelLabel(p.id)}${p.intellectEstimated ? ' (~)' : ''}${p.local ? ' · free' : ''}`
    labelText.set(p.id, text)
    const x0 = x(p.costPerMTok) + 8
    const x1 = x0 + approxLabelWidth(text)
    let py = y(p.intellect) + 3
    let moved = true
    while (moved) {
      moved = false
      for (const prev of placed) {
        if (Math.abs(py - prev.py) < 10 && x0 < prev.x1 && x1 > prev.x0) {
          py = prev.py + 10
          moved = true
        }
      }
    }
    placed.push({ x0, x1, py })
    labelY.set(p.id, py)
  }

  // Points, with a larger transparent hit target and a native tooltip carrying
  // the full derivation.
  for (const p of points) {
    const cx = String(x(p.costPerMTok))
    const cy = String(y(p.intellect))
    const emphasis = p.onFrontier ? 'var(--accent)' : 'var(--border-strong)'
    const dot = p.intellectEstimated
      ? svgEl('circle', {
          cx,
          cy,
          r: '5',
          fill: 'var(--bg-base)',
          stroke: emphasis,
          'stroke-width': '2',
          class: 'frontier-point estimated',
        })
      : svgEl('circle', {
          cx,
          cy,
          r: '5',
          fill: emphasis,
          class: 'frontier-point',
        })
    const hit = svgEl('circle', { cx, cy, r: '11', fill: 'transparent', class: 'frontier-hit' })
    hit.append(svgEl('title', {}, tooltipFor(p)))
    const text = labelText.get(p.id)
    if (text !== undefined) {
      svg.append(
        svgEl(
          'text',
          {
            x: String(x(p.costPerMTok) + 8),
            y: String(labelY.get(p.id) ?? y(p.intellect) + 3),
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

  // Right gutter: scored-but-unpriced models at their TRUE y on the shared
  // intellect axis, offset into a marked "no price" margin instead of claiming
  // a fake $0.
  if (unpriced.length > 0) {
    const sepX = width - gutterW + 4
    const dotX = width - gutterW + 16
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
          x: String(dotX - 2),
          y: String(MARGIN.top + plotH + 14),
          'font-size': '9',
          fill: 'var(--text-muted)',
        },
        'no price yet',
      ),
    )
    let prevY = -Infinity
    for (const u of [...unpriced].sort((a, b) => b.intellect - a.intellect)) {
      const dotY = y(u.intellect)
      const labelYPos = Math.max(dotY + 3, prevY + 10)
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
      svg.append(
        dot,
        svgEl(
          'text',
          {
            x: String(dotX + 9),
            y: String(labelYPos),
            'font-size': '9',
            fill: 'var(--text-secondary)',
            class: 'gutter-unpriced-label',
          },
          `${displayModelLabel(u.id)} · ${u.estimated ? '~' : ''}${String(u.intellect)}`,
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
      dot.append(
        svgEl(
          'title',
          {},
          `${u.id}\n$${String(u.costPerMTok)}/MTok blended (80% input / 20% output)\nNo sourced intellect measurement yet — position on price only.`,
        ),
      )
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
): IntellectFrontierPanel {
  const chartHost = el('div', { class: 'frontier-chart' })
  const liveNotes = el('div', { class: 'field-hint frontier-live-notes' })
  const compositeHost = el('div', { class: 'frontier-composite-strip' })
  let lastPoints: FrontierPoint[] = []
  let lastGutters: FrontierGutters = {}
  const expandBtn = el('button', { type: 'button', class: 'frontier-expand' }, 'Expand')
  expandBtn.addEventListener('click', () => {
    if (lastPoints.length === 0) return
    const dialog = el('dialog', { class: 'frontier-expand-dialog' })
    const close = el('button', { type: 'button' }, 'Close')
    close.addEventListener('click', () => {
      dialog.remove()
    })
    dialog.append(renderFrontierSvg(lastPoints, { width: 920, height: 460 }, lastGutters), close)
    fieldset.append(dialog)
    // jsdom (tests) lacks showModal; the open attribute is the fallback.
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')
  })
  const fieldset = el(
    'fieldset',
    {},
    el('legend', {}, 'Model value map'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Where each model sits on intellect vs price. Models on the line are the best value at their level; hover a point for how its score was derived. ',
      expandBtn,
    ),
    chartHost,
    el(
      'p',
      { class: 'field-hint frontier-legend' },
      'Filled accent = on the frontier · grey = dominated (better value exists at its level) · hollow ring / (~) = estimated value — hover any point for exactly how its number was derived.',
    ),
    liveNotes,
    compositeHost,
  )

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
    // The gate: live models join ONLY when the feed's declared index version
    // matches the canonical one (when declared) AND its values agree with our
    // curated anchors — a renormalised feed must never share the axis.
    const live = liveIntellectCandidates(liveFetch.models, liveFetch.indexVersion)
    const liveNoteParts: Array<string | HTMLElement> = []
    if (liveFetch.models.length > 0 && live.verification.verified) {
      liveNoteParts.push(
        `Live points from the Artificial Analysis API, verified against ${String(live.verification.anchorsChecked)} curated anchors. ${INTELLECT_ATTRIBUTION}.`,
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
    const allPoints = frontierForKnownModels([
      ...baseCandidates,
      ...live.candidates,
      ...livePricedCurated,
    ])
    // A verified feed can carry a hundred-plus priced models; the map's job is
    // the frontier, so dominated LIVE points collapse into a disclosure rather
    // than each claiming a labelled dot. Curated/local/provider points always
    // plot — the user chose to hold those. Dropping dominated points cannot
    // change the frontier.
    const liveIds = new Set(live.candidates.map((c) => c.id))
    const dominatedLive = allPoints.filter((p) => liveIds.has(p.id) && !p.onFrontier)
    const points = allPoints.filter((p) => !liveIds.has(p.id) || p.onFrontier)
    const plottedIds = new Set(points.map((p) => resolveIntellectModelId(p.id) ?? p.id))
    lastPoints = points
    lastGutters = {
      unpriced: unpricedCanonicalModels(plottedIds, live.hintOnly),
      unscored: unscoredPricedModels(extraProviders),
    }
    if (dominatedLive.length > 0) {
      liveNoteParts.push(
        el(
          'details',
          { class: 'frontier-dominated-live' },
          el(
            'summary',
            {},
            `${String(dominatedLive.length)} live-scored models are dominated (better value exists at their level)`,
          ),
          el(
            'p',
            {},
            dominatedLive
              .map(
                (p) =>
                  `${displayModelLabel(p.id)} (${p.intellectEstimated ? '~' : ''}${String(p.intellect)} at $${String(Number(p.costPerMTok.toFixed(2)))})`,
              )
              .join(' · '),
          ),
        ),
      )
    }
    const unscoredList = lastGutters.unscored ?? []
    let chart: SVGSVGElement | HTMLElement
    try {
      chart =
        points.length > 0
          ? renderFrontierSvg(points, {}, lastGutters)
          : el('p', { class: 'field-hint' }, 'No models with a sourced intellect score yet.')
    } catch (err) {
      // The map must never take the settings dialog down with it.
      chart = el(
        'p',
        { class: 'field-hint' },
        `The value map failed to render: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    chartHost.replaceChildren(
      chart,
      ...(unscoredList.length > UNSCORED_ROW_LIMIT
        ? [
            el(
              'details',
              { class: 'field-hint frontier-unscored-list' },
              el(
                'summary',
                {},
                `${String(unscoredList.length)} priced models without an intellect score`,
              ),
              el(
                'p',
                {},
                unscoredList
                  .map(
                    (u) =>
                      `${displayModelLabel(u.id)} ($${String(Number(u.costPerMTok.toFixed(2)))})`,
                  )
                  .join(' · '),
              ),
            ),
          ]
        : []),
    )
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
