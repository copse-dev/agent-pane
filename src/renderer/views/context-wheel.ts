import type { ContextBreakdown, ContextSegmentKey, ContextSnapshot } from '@shared/types'

const RADIUS = 6
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const SVG_NS = 'http://www.w3.org/2000/svg'

/** Distinct ring/swatch colour per context part. */
const SEGMENT_COLORS: Record<ContextSegmentKey, string> = {
  system: '#6aa3ff',
  tools: '#4fd1c5',
  mcp: '#b794f4',
  skills: '#f6ad55',
  history: '#a0aec0',
  message: '#68d391',
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

function pctOf(part: number, whole: number): number {
  if (whole <= 0) return 0
  return Math.round((part / whole) * 100)
}

export interface ContextWheelOptions {
  usageLine?: string | null
  breakdown?: ContextBreakdown | null
  /**
   * When true the multi-arc breakdown ring replaces the live snapshot fill
   * (pre-send / fresh threads). When false the measured snapshot ring stays,
   * but a provided `breakdown` is still surfaced as the hover popover so
   * already-run primary chats keep their context-window breakdown on hover.
   */
  breakdownRing?: boolean
}

export function createContextWheel(): {
  root: HTMLElement
  update: (
    snapshot: ContextSnapshot | null | undefined,
    running: boolean,
    options?: ContextWheelOptions,
  ) => void
} {
  const root = document.createElement('div')
  root.className = 'context-wheel'
  root.hidden = true

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('aria-hidden', 'true')

  const track = document.createElementNS(SVG_NS, 'circle')
  track.setAttribute('cx', '8')
  track.setAttribute('cy', '8')
  track.setAttribute('r', String(RADIUS))
  track.setAttribute('fill', 'none')
  track.setAttribute('stroke-width', '2')
  track.classList.add('context-wheel-track')

  // Multi-arc group used in breakdown mode (one arc per context part).
  const segGroup = document.createElementNS(SVG_NS, 'g')
  segGroup.setAttribute('transform', 'rotate(-90 8 8)')

  // Single arc used in snapshot (live fill) mode.
  const fill = document.createElementNS(SVG_NS, 'circle')
  fill.setAttribute('cx', '8')
  fill.setAttribute('cy', '8')
  fill.setAttribute('r', String(RADIUS))
  fill.setAttribute('fill', 'none')
  fill.setAttribute('stroke-width', '2')
  fill.setAttribute('transform', 'rotate(-90 8 8)')
  fill.classList.add('context-wheel-fill')

  const label = document.createElement('span')
  label.className = 'context-wheel-label'

  const popover = document.createElement('div')
  popover.className = 'context-wheel-popover'
  popover.hidden = true

  svg.append(track, segGroup, fill)
  root.append(svg, label, popover)

  let breakdownActive = false

  function showPopover(): void {
    if (breakdownActive) popover.hidden = false
  }
  function hidePopover(): void {
    popover.hidden = true
  }
  root.addEventListener('mouseenter', showPopover)
  root.addEventListener('mouseleave', hidePopover)
  root.addEventListener('focusin', showPopover)
  root.addEventListener('focusout', hidePopover)

  function clearSegments(): void {
    while (segGroup.firstChild) segGroup.firstChild.remove()
  }

  /** Build the hover popover (header + one row per segment) from a breakdown. */
  function renderPopover(breakdown: ContextBreakdown): void {
    const { totalTokens, contextWindow, segments } = breakdown
    const pct = pctOf(totalTokens, contextWindow)
    clearPopover()
    const header = document.createElement('div')
    header.className = 'context-wheel-popover-header'
    header.textContent = `Context · ${formatTokenCount(totalTokens)} / ${formatTokenCount(
      contextWindow,
    )} (${String(pct)}%)`
    popover.append(header)
    for (const segment of segments) {
      const row = document.createElement('div')
      row.className = 'context-wheel-popover-row'
      const swatch = document.createElement('span')
      swatch.className = 'context-wheel-popover-swatch'
      swatch.style.background = SEGMENT_COLORS[segment.key]
      const name = document.createElement('span')
      name.className = 'context-wheel-popover-name'
      name.textContent = segment.label
      const value = document.createElement('span')
      value.className = 'context-wheel-popover-value'
      value.textContent = `${formatTokenCount(segment.tokens)} · ${String(
        pctOf(segment.tokens, contextWindow),
      )}%`
      row.append(swatch, name, value)
      popover.append(row)
    }
  }

  function renderBreakdown(breakdown: ContextBreakdown): void {
    breakdownActive = true
    root.hidden = false
    root.classList.add('has-breakdown')
    root.tabIndex = 0
    fill.style.display = 'none'

    const { totalTokens, contextWindow, segments } = breakdown
    const pct = pctOf(totalTokens, contextWindow)
    label.textContent = `${String(pct)}%`

    // When the draft already exceeds the window, fill the whole ring proportionally.
    const denom = Math.max(contextWindow, totalTokens, 1)
    clearSegments()
    let offset = 0
    for (const segment of segments) {
      const len = (segment.tokens / denom) * CIRCUMFERENCE
      if (len <= 0) continue
      const arc = document.createElementNS(SVG_NS, 'circle')
      arc.setAttribute('cx', '8')
      arc.setAttribute('cy', '8')
      arc.setAttribute('r', String(RADIUS))
      arc.setAttribute('fill', 'none')
      arc.setAttribute('stroke-width', '2')
      arc.setAttribute('stroke', SEGMENT_COLORS[segment.key])
      arc.setAttribute('stroke-dasharray', `${String(len)} ${String(CIRCUMFERENCE)}`)
      arc.setAttribute('stroke-dashoffset', String(-offset))
      segGroup.append(arc)
      offset += len
    }

    renderPopover(breakdown)

    const lines = segments.map(
      (s) =>
        `${s.label}: ${formatTokenCount(s.tokens)} (${String(pctOf(s.tokens, contextWindow))}%)`,
    )
    root.title = [
      `Context: ${formatTokenCount(totalTokens)} / ${formatTokenCount(contextWindow)} (${String(pct)}%)`,
      ...lines,
    ].join('\n')
    root.setAttribute(
      'aria-label',
      `Estimated context ${String(pct)}% of window, ${formatTokenCount(
        totalTokens,
      )} of ${formatTokenCount(contextWindow)} tokens`,
    )
  }

  function clearPopover(): void {
    while (popover.firstChild) popover.firstChild.remove()
  }

  function resetToSnapshotMode(): void {
    breakdownActive = false
    hidePopover()
    root.classList.remove('has-breakdown')
    root.removeAttribute('tabindex')
    fill.style.display = ''
    clearSegments()
  }

  function renderSnapshot(
    snapshot: ContextSnapshot,
    running: boolean,
    options?: ContextWheelOptions,
  ): void {
    const ratio = Math.min(1, Math.max(0, snapshot.fillRatio))
    const pct = Math.round(ratio * 100)
    const visible = running || ratio > 0.01
    root.hidden = !visible
    if (!visible) return

    fill.setAttribute(
      'stroke-dasharray',
      `${String(ratio * CIRCUMFERENCE)} ${String(CIRCUMFERENCE)}`,
    )
    label.textContent = `${String(pct)}%`
    const contextLine = `Context: ${formatTokenCount(snapshot.conversationTokens)} / ${formatTokenCount(snapshot.conversationBudget)} (${String(pct)}%)`
    const usageLine = options?.usageLine?.trim()
    root.title = usageLine ? `${contextLine}\n${usageLine}` : contextLine
    const ariaUsage = usageLine ? `; ${usageLine}` : ''
    root.setAttribute(
      'aria-label',
      `Context ${String(pct)}% used, ${formatTokenCount(snapshot.conversationTokens)} of ${formatTokenCount(snapshot.conversationBudget)} tokens${ariaUsage}`,
    )

    // Existing (already-run) chats keep the measured live-fill ring, but still
    // expose the part-by-part breakdown on hover when one is available. Subagent
    // and remote-agent windows don't report a breakdown, so they fall through
    // here with no popover — matching their non-interactive presentation.
    const breakdown = options?.breakdown
    if (breakdown && breakdown.totalTokens > 0 && breakdown.contextWindow > 0) {
      breakdownActive = true
      root.tabIndex = 0
      renderPopover(breakdown)
    }
  }

  function update(
    snapshot: ContextSnapshot | null | undefined,
    running: boolean,
    options?: ContextWheelOptions,
  ): void {
    const breakdown = options?.breakdown
    if (
      !running &&
      options?.breakdownRing &&
      breakdown &&
      breakdown.totalTokens > 0 &&
      breakdown.contextWindow > 0
    ) {
      renderBreakdown(breakdown)
      return
    }

    resetToSnapshotMode()
    if (!snapshot || snapshot.conversationBudget <= 0) {
      root.hidden = true
      return
    }
    renderSnapshot(snapshot, running, options)
  }

  return { root, update }
}
