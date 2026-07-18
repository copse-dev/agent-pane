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
  frontierForKnownModels,
  type FrontierCandidate,
  type FrontierPoint,
} from '@copse/llm/pareto-frontier.ts'
import { explainIntellectScore } from '@copse/llm/model-intellect.ts'
import { compositeIntellect, type CompositeIntellect } from '@copse/llm/composite-intellect.ts'
import { getLocalModelCapability, localBenchmarkScore } from '@copse/llm/local-model-catalog.ts'
import { el } from '../dom/helpers.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'

const WIDTH = 460
const HEIGHT = 230
const MARGIN = { top: 14, right: 96, bottom: 34, left: 40 }

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

export function renderFrontierSvg(points: readonly FrontierPoint[]): SVGSVGElement {
  const plotW = WIDTH - MARGIN.left - MARGIN.right
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom
  const maxCost = Math.max(1, ...points.map((p) => p.costPerMTok)) * 1.15
  const maxIntellect = Math.max(10, ...points.map((p) => p.intellect)) + 5
  const minIntellect = Math.max(0, Math.min(...points.map((p) => p.intellect)) - 8)
  const x = (cost: number): number => MARGIN.left + (cost / maxCost) * plotW
  const y = (intellect: number): number =>
    MARGIN.top + plotH - ((intellect - minIntellect) / (maxIntellect - minIntellect)) * plotH

  const svg = svgEl('svg', {
    viewBox: `0 0 ${String(WIDTH)} ${String(HEIGHT)}`,
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
        y: String(HEIGHT - 4),
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

  // Direct labels sit right of their point; when several models cluster (the
  // frontier bunches near the top-right), push later labels down so none
  // overlap. Deterministic: processed in y order.
  const labelY = new Map<string, number>()
  const placed: Array<{ px: number; py: number }> = []
  for (const p of [...points].sort((a, b) => y(a.intellect) - y(b.intellect))) {
    const px = x(p.costPerMTok) + 8
    let py = y(p.intellect) + 3
    for (const prev of placed) {
      if (Math.abs(px - prev.px) < 120 && py - prev.py < 10 && py - prev.py > -10) {
        py = prev.py + 10
      }
    }
    placed.push({ px, py })
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
    const label = svgEl(
      'text',
      {
        x: String(x(p.costPerMTok) + 8),
        y: String(labelY.get(p.id) ?? y(p.intellect) + 3),
        'font-size': '9',
        fill: 'var(--text-secondary)',
        class: 'frontier-label',
      },
      `${p.id}${p.intellectEstimated ? ' (~)' : ''}${p.local ? ' · free' : ''}`,
    )
    svg.append(dot, label, hit)
  }
  return svg
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
export function createIntellectFrontierPanel(
  loadLocalModels: () => Promise<string[]>,
): IntellectFrontierPanel {
  const chartHost = el('div', { class: 'frontier-chart' })
  const compositeHost = el('div', { class: 'frontier-composite-strip' })
  const fieldset = el(
    'fieldset',
    {},
    el('legend', {}, 'Model value map'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Where each model sits on intellect vs price. Models on the line are the best value at their level; hover a point for how its score was derived.',
    ),
    chartHost,
    compositeHost,
  )

  async function refresh(): Promise<void> {
    let localIds: string[]
    try {
      localIds = await loadLocalModels()
    } catch {
      localIds = []
    }
    const points = frontierForKnownModels(localFrontierCandidates(localIds))
    chartHost.replaceChildren(
      points.length > 0
        ? renderFrontierSvg(points)
        : el('p', { class: 'field-hint' }, 'No models with a sourced intellect score yet.'),
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
