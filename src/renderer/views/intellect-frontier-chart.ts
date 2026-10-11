import type { FrontierPoint, FrontierCostAxis } from '@copse/llm/pareto-frontier.ts'
import type { CompositeIntellect } from '@copse/llm/composite-intellect.ts'
import { explainIntellectScore } from '@copse/llm/model-intellect.ts'
import { el } from '../dom/helpers.ts'
import {
  displayModelLabel,
  pointTooltipContent,
  unpricedTooltipContent,
  unscoredTooltipContent,
  wireTooltip,
  tooltipFor,
  type FrontierTooltip,
} from './intellect-frontier-tooltip.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'

const WIDTH = 460
const HEIGHT = 290
// A tight right margin: labels no longer need a wide reserved gutter because a
// point near the right edge flips its label to the left (see the label
// placement below), so the plot itself claims almost the full panel width.
const MARGIN = { top: 14, right: 20, bottom: 34, left: 40 }

/** Clearance kept between a lifted frontier label and the frontier line. */
const LABEL_LINE_GAP = 3

/** Screen-space grouping/offset for near-zero price columns. */
const POINT_SPLAY_COLUMN_PX = 7
const POINT_SPLAY_STEP_PX = 6
const POINT_SPLAY_MAX_PX = 18

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

export interface CompositeScoredModel {
  id: string
  composite: CompositeIntellect
}

/**
 * The composite models' own chart: a one-axis dot strip on the copse-intellect
 * 0–100 scale. A SEPARATE chart, deliberately · composite values are not on
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
        `${m.id}\nscore ${String(m.composite.value)} · separate scale (not comparable with the main chart)\n${m.composite.basis}\ncost: free (runs on-device)`,
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

/** Nice round tick values covering [0, max]. */
function ticks(max: number, count: number): number[] {
  const step = Math.max(1, Math.ceil(max / count))
  const out: number[] = []
  for (let v = 0; v <= max; v += step) out.push(v)
  return out
}

/** Models that have one coordinate but not the other · chart-margin gutters. */
export interface FrontierGutters {
  /** Scored on the canonical scale, no price · right gutter, true y position. */
  unpriced?: readonly CanonicalScoredModel[]
  /** Priced, no sourced score · bottom gutter, true x position. */
  unscored?: readonly { id: string; costPerMTok: number }[]
}

export type FrontierLabelMode = 'summary' | 'all'

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
  labelMode: FrontierLabelMode = 'summary',
): SVGSVGElement {
  const unpriced = gutters.unpriced ?? []
  // Bottom gutter (priced, no intellect) only applies on the blended axis · on
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

  // Prices near zero project to the same narrow column. Splay columns of three
  // or more non-frontier points a few pixels horizontally so their marks and
  // hover regions remain individually legible. Frontier marks stay at their
  // true data coordinate because moving one away from its path makes the value
  // line and point appear to disagree.
  const displayX = new Map<string, number>(points.map((p) => [p.id, x(p.costPerMTok)]))
  const byRawX = points
    .filter((point) => !point.onFrontier)
    .sort((a, b) => x(a.costPerMTok) - x(b.costPerMTok) || y(a.intellect) - y(b.intellect))
  for (let start = 0; start < byRawX.length;) {
    const first = byRawX[start]
    if (!first) break
    const columnX = x(first.costPerMTok)
    let end = start + 1
    while (end < byRawX.length) {
      const candidate = byRawX[end]
      if (!candidate || x(candidate.costPerMTok) - columnX > POINT_SPLAY_COLUMN_PX) break
      end++
    }
    const column = byRawX.slice(start, end)
    if (column.length >= 3) {
      column.sort((a, b) => y(a.intellect) - y(b.intellect))
      const nearLeft = columnX - POINT_SPLAY_MAX_PX < plotLeft
      column.forEach((point, index) => {
        const centered = (index - (column.length - 1) / 2) * POINT_SPLAY_STEP_PX
        const fanPhase = index % 6
        const fanStep = fanPhase <= 3 ? fanPhase : 6 - fanPhase
        const offset = nearLeft
          ? fanStep * POINT_SPLAY_STEP_PX
          : Math.max(-POINT_SPLAY_MAX_PX, Math.min(POINT_SPLAY_MAX_PX, centered))
        displayX.set(
          point.id,
          Math.max(plotLeft, Math.min(plotLeft + plotW, x(point.costPerMTok) + offset)),
        )
      })
    }
    start = end
  }
  const pointX = (point: FrontierPoint): number => displayX.get(point.id) ?? x(point.costPerMTok)

  // Bottom-gutter rows assigned greedily so labels never overlap within a row.
  // Past UNSCORED_ROW_LIMIT the band collapses to one label-less density row.
  const dense = unscored.length > UNSCORED_ROW_LIMIT
  const unscoredRows: Array<{
    id: string
    costPerMTok: number
    row: number
    text: string
  }> = []
  {
    const rowEnds: number[] = []
    for (const u of [...unscored].sort((a, b) => a.costPerMTok - b.costPerMTok)) {
      if (dense) {
        unscoredRows.push({
          id: u.id,
          costPerMTok: u.costPerMTok,
          row: 0,
          text: '',
        })
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
      ? 'AA cost per intelligence index task ($) · local/plan models plot at $0'
      : 'Blended price, $/MTok (80% in / 20% out) · local models plot at $0'
  const ariaLabel =
    costAxis === 'perTask'
      ? 'Model intellect versus AA cost per intelligence index task, with the Pareto frontier'
      : 'Model intellect versus blended price, with the Pareto frontier'

  const svg = svgEl('svg', {
    viewBox: `0 0 ${String(width)} ${String(height)}`,
    role: 'img',
    'aria-label': ariaLabel,
    'data-cost-axis': costAxis,
    'data-label-mode': labelMode,
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
      'Intellect',
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
  const frontierMidpointId = frontierByX[Math.floor((frontierByX.length - 1) / 2)]?.id
  const labelledPoints = [...points].sort(
    (a, b) =>
      (labelMode === 'summary'
        ? Number(b.id === frontierMidpointId) - Number(a.id === frontierMidpointId)
        : 0) ||
      Number(b.onFrontier) - Number(a.onFrontier) ||
      (a.onFrontier ? y(b.intellect) - y(a.intellect) : y(a.intellect) - y(b.intellect)),
  )
  const plotBottom = MARGIN.top + plotH
  const rightEdge = width - 2
  const labelText = new Map<string, string>()
  const labelY = new Map<string, number>()
  const labelX = new Map<string, number>()
  const labelAnchor = new Map<string, string>()
  const labelLeader = new Map<string, { x1: number; y1: number; x2: number; y2: number }>()
  // Dots are obstacles too · a label must not sit under another point's mark.
  const placed: Array<{ x0: number; x1: number; py: number }> = points.map((p) => ({
    x0: pointX(p) - 7,
    x1: pointX(p) + 7,
    py: y(p.intellect) + 3,
  }))
  for (const p of labelledPoints) {
    const suffix = p.plan ? ' · plan' : p.local ? ' · free' : ''
    const text = `${displayModelLabel(p.id)}${p.quant ? ` @${p.quant}` : ''}${p.intellectEstimated ? ' (~)' : ''}${suffix}`
    const w = approxLabelWidth(text)
    const px = pointX(p)
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
    const naturalY = y(p.intellect) + 3
    let py = naturalY
    // A frontier point sits ON the line, so the adjacent segment can run through
    // its side label. When it does, lift the label clear ABOVE the line · the
    // Pareto-empty upper region · rather than leave the line crossing the text.
    const prefersUp = p.onFrontier
    let lineRange: { min: number; max: number } | null = null
    if (prefersUp && labelMode === 'all') {
      const range = frontierYRange(x0, x1)
      lineRange = range
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
    const nudgeClear = (start: number, direction: -1 | 1): number => {
      let nextY = start
      let moved = true
      while (moved) {
        moved = false
        for (const prev of placed) {
          if (Math.abs(nextY - prev.py) >= 10 || x0 >= prev.x1 || x1 <= prev.x0) continue
          const next = prev.py + direction * 10
          if (direction < 0 ? next < nextY : next > nextY) {
            nextY = next
            moved = true
          }
        }
      }
      return nextY
    }
    if (labelMode === 'summary') {
      const blocked = placed.some(
        (prev) => Math.abs(naturalY - prev.py) < 10 && x0 < prev.x1 && x1 > prev.x0,
      )
      if (blocked) continue
      py = naturalY
    } else {
      py = nudgeClear(py, prefersUp ? -1 : 1)
    }
    if (labelMode === 'all' && prefersUp && py - 8 < MARGIN.top) {
      // Put the representative/all-mode overflow below the line, then cascade
      // downward through dots and labels. Starting under the whole segment span
      // means the frontier cannot run through the text on this fallback side.
      const belowLine = (lineRange?.max ?? y(p.intellect)) + LABEL_LINE_GAP + 9
      py = nudgeClear(Math.max(y(p.intellect) + 12, belowLine), 1)
    }
    if (py > plotBottom) {
      // Drop a label that can only land below the plot · hover still has it.
      continue
    }
    const shift = Math.abs(py - naturalY)
    // Inline labels are truly direct: their baseline stays tied to the dot.
    // If collision/line avoidance requires movement, omit that label and leave
    // identification to hover. The expanded chart may move it, but always adds
    // a leader once the association would otherwise become ambiguous.
    if (labelMode === 'all' && shift > 6) {
      labelLeader.set(p.id, {
        x1: px,
        y1: y(p.intellect),
        x2: anchor === 'start' ? tx - 2 : tx + 2,
        y2: py - 3,
      })
    }
    placed.push({ x0, x1, py })
    labelText.set(p.id, text)
    labelY.set(p.id, py)
    labelX.set(p.id, tx)
    labelAnchor.set(p.id, anchor)
  }

  // Points, with a larger transparent hit target and a rich hover card.
  for (const p of points) {
    const displayedCx = pointX(p)
    const cx = String(displayedCx)
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
    const nearestDistance = points.reduce((nearest, other) => {
      if (other === p) return nearest
      return Math.min(
        nearest,
        Math.hypot(pointX(other) - displayedCx, y(other.intellect) - y(p.intellect)),
      )
    }, Infinity)
    const hitRadius = Math.max(5, Math.min(11, nearestDistance / 2 - 0.5))
    const hit = svgEl('circle', {
      cx,
      cy,
      r: String(hitRadius),
      fill: 'none',
      'pointer-events': 'all',
      class: 'frontier-hit',
      'data-model-id': p.id,
    })
    const restingRadius = dot.getAttribute('r') ?? '5'
    hit.addEventListener('mouseenter', () => {
      dot.setAttribute('r', '6.5')
    })
    hit.addEventListener('mouseleave', () => {
      dot.setAttribute('r', restingRadius)
    })
    if (tooltip) wireTooltip(hit, tooltip, () => pointTooltipContent(p, costAxis), p.id)
    else hit.append(svgEl('title', {}, tooltipFor(p, costAxis)))
    const text = labelText.get(p.id)
    if (text !== undefined) {
      const leader = labelLeader.get(p.id)
      if (leader) {
        svg.append(
          svgEl('line', {
            x1: String(leader.x1),
            y1: String(leader.y1),
            x2: String(leader.x2),
            y2: String(leader.y2),
            stroke: 'var(--border-strong)',
            'stroke-width': '0.75',
            'stroke-opacity': '0.65',
            class: 'frontier-label-leader',
            'data-model-id': p.id,
          }),
        )
      }
      svg.append(
        svgEl(
          'text',
          {
            x: String(labelX.get(p.id) ?? pointX(p) + 8),
            y: String(labelY.get(p.id) ?? y(p.intellect) + 3),
            'text-anchor': labelAnchor.get(p.id) ?? 'start',
            'font-size': '9',
            fill: 'var(--text-secondary)',
            ...(labelMode === 'summary'
              ? {
                  stroke: 'var(--bg-base)',
                  'stroke-width': '3',
                  'paint-order': 'stroke',
                }
              : {}),
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
              ? `${u.id}\n${explanation.steps.map((s) => `${s.step}: ${s.detail}`).join('\n')}\nNo price data yet · position on intellect only.`
              : `${u.id}\nintellect ${u.estimated ? '~' : ''}${String(u.intellect)} (live Artificial Analysis)\nNo price data yet · position on intellect only.`,
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
            `${u.id}\n$${String(u.costPerMTok)}/MTok blended (80% input / 20% output)\nNo sourced intellect measurement yet · position on price only.`,
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
 * dialog down · a broken chart degrades to a quiet note. Shared by the inline
 * panel and the pop-out (which passes a larger size).
 */
export function renderChart(
  points: readonly FrontierPoint[],
  gutters: FrontierGutters,
  tooltip: FrontierTooltip | undefined,
  size: { width?: number; height?: number } = {},
  costAxis: FrontierCostAxis = 'blended',
  labelMode: FrontierLabelMode = 'summary',
): SVGSVGElement | HTMLElement {
  try {
    return points.length > 0
      ? renderFrontierSvg(points, size, gutters, tooltip, costAxis, labelMode)
      : el('p', { class: 'field-hint' }, 'No models with a sourced intellect score yet.')
  } catch (err) {
    return el(
      'p',
      { class: 'field-hint' },
      `The value map failed to render: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
