import type { ContextBreakdown, ContextSegmentKey, ContextSnapshot } from '@shared/types'
import type { FooterUsageTooltipModel } from '@shared/usage/footer-usage-tooltip.ts'
import { appendUsageSections } from './footer-usage-popover.ts'

const RADIUS = 6
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const SVG_NS = 'http://www.w3.org/2000/svg'

/** Fill ratio at which the ring turns amber: compaction is close. */
export const CONTEXT_WARN_RATIO = 0.8
/** Fill ratio at which the ring turns red: the next send may overflow the window. */
export const CONTEXT_DANGER_RATIO = 0.95

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
  /** Label shown when the live snapshot came from an external agent. */
  snapshotSource?: string | null
  /**
   * Token usage, cache, cost and subagent rows, shown beneath the context
   * section of the same hover. With no context figures to draw, the wheel
   * stays visible as an empty ring so usage still has an anchor.
   */
  usage?: FooterUsageTooltipModel | null
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

  const popover = document.createElement('div')
  popover.className = 'context-wheel-popover'
  popover.hidden = true

  svg.append(track, segGroup, fill)
  root.append(svg, popover)

  let popoverActive = false
  let currentUsage: FooterUsageTooltipModel | null = null
  let hovered = false
  let focused = false

  function showPopover(): void {
    if (popoverActive) popover.hidden = false
  }
  function hidePopover(): void {
    popover.hidden = true
  }
  /** Reopen after a re-render, if the pointer never left and there is still something to show. */
  function restoreEngagedPopover(): void {
    if ((hovered || focused) && popoverActive && !root.hidden) popover.hidden = false
  }
  // Pointer clicks must not pin a hover by taking focus. Keyboard focus still
  // opens the details; interactions inside the popover keep their defaults.
  root.addEventListener('mousedown', (event) => {
    if (event.target instanceof Node && !popover.contains(event.target)) event.preventDefault()
  })
  root.addEventListener('mouseenter', () => {
    hovered = true
    showPopover()
  })
  root.addEventListener('mouseleave', () => {
    hovered = false
    if (!focused) hidePopover()
  })
  root.addEventListener('focusin', () => {
    focused = true
    showPopover()
  })
  root.addEventListener('focusout', () => {
    focused = false
    if (!hovered) hidePopover()
  })

  function clearSegments(): void {
    while (segGroup.firstChild) segGroup.firstChild.remove()
  }

  /** Build the hover popover (header + one row per segment) from a breakdown. */
  function renderPopover(breakdown: ContextBreakdown): void {
    const { totalTokens, contextWindow, segments } = breakdown
    const pct = pctOf(totalTokens, contextWindow)
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

  /** Rebuild the popover: the context section (when there is one), then usage. */
  function composePopover(drawContext: (() => void) | null): void {
    clearPopover()
    drawContext?.()
    if (!currentUsage) return
    if (drawContext) {
      const divider = document.createElement('div')
      divider.className = 'footer-usage-popover-divider'
      popover.append(divider)
    }
    appendUsageSections(popover, currentUsage)
  }

  function renderBreakdown(breakdown: ContextBreakdown): void {
    popoverActive = true
    root.hidden = false
    root.classList.add('has-breakdown')
    root.tabIndex = 0
    fill.style.display = 'none'

    const { totalTokens, contextWindow, segments } = breakdown
    const pct = pctOf(totalTokens, contextWindow)

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

    composePopover(() => {
      renderPopover(breakdown)
    })

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
    popoverActive = false
    popover.hidden = true
    root.classList.remove('has-breakdown')
    root.removeAttribute('tabindex')
    fill.style.display = ''
    clearSegments()
  }

  /** Build an aggregate-only popover from a live snapshot, with an optional source note. */
  function renderSnapshotPopover(snapshot: ContextSnapshot, source?: string | null): void {
    const pct = pctOf(snapshot.conversationTokens, snapshot.conversationBudget)
    const header = document.createElement('div')
    header.className = 'context-wheel-popover-header'
    header.textContent = `Context · ${formatTokenCount(
      snapshot.conversationTokens,
    )} / ${formatTokenCount(snapshot.conversationBudget)} (${String(pct)}%)`
    popover.append(header)
    if (!source) return
    const note = document.createElement('div')
    note.className = 'context-wheel-popover-note'
    note.textContent = source
    popover.append(note)
  }

  /** Colour the live fill as the window runs out: grey, amber, then red. */
  function setFillState(ratio: number): void {
    fill.classList.toggle('is-danger', ratio >= CONTEXT_DANGER_RATIO)
    fill.classList.toggle('is-warn', ratio >= CONTEXT_WARN_RATIO && ratio < CONTEXT_DANGER_RATIO)
  }

  function renderSnapshot(
    snapshot: ContextSnapshot,
    running: boolean,
    options?: ContextWheelOptions,
  ): void {
    const ratio = Math.min(1, Math.max(0, snapshot.fillRatio))
    const visible = running || ratio > 0.01 || currentUsage !== null
    root.hidden = !visible
    if (!visible) return

    fill.setAttribute(
      'stroke-dasharray',
      `${String(ratio * CIRCUMFERENCE)} ${String(CIRCUMFERENCE)}`,
    )
    setFillState(ratio)
    // The title and aria-label quote the same figures as the hover beside the
    // ring: when a part-by-part breakdown is shown it counts the whole window,
    // while the snapshot counts the conversation budget, and quoting one in
    // the label and the other in the hover made one control disagree with itself.
    const shownBreakdown = options?.breakdown
    const labelled =
      shownBreakdown && shownBreakdown.totalTokens > 0 && shownBreakdown.contextWindow > 0
        ? { tokens: shownBreakdown.totalTokens, budget: shownBreakdown.contextWindow }
        : { tokens: snapshot.conversationTokens, budget: snapshot.conversationBudget }
    const pct = pctOf(labelled.tokens, labelled.budget)
    const contextLine = `Context: ${formatTokenCount(labelled.tokens)} / ${formatTokenCount(labelled.budget)} (${String(pct)}%)`
    const usageLine = options?.usageLine?.trim()
    root.title = usageLine ? `${contextLine}\n${usageLine}` : contextLine
    const ariaUsage = usageLine ? `; ${usageLine}` : ''
    root.setAttribute(
      'aria-label',
      `Context ${String(pct)}% used, ${formatTokenCount(labelled.tokens)} of ${formatTokenCount(labelled.budget)} tokens${ariaUsage}`,
    )

    // Existing (already-run) chats keep the measured live-fill ring, but still
    // expose the part-by-part breakdown on hover when one is available.
    popoverActive = true
    root.tabIndex = 0
    const breakdown = options?.breakdown
    if (breakdown && breakdown.totalTokens > 0 && breakdown.contextWindow > 0) {
      composePopover(() => {
        renderPopover(breakdown)
      })
      return
    }
    // No breakdown to show: the caller suppresses the pre-send estimate while a
    // run is in flight (the live snapshot is authoritative then), and subagent /
    // remote-agent windows never produce one. Fall back to the aggregate the
    // ring is already drawing rather than leaving the wheel inert on hover — it
    // reads state we already hold, so it costs no estimate and no IPC. ACP
    // snapshots additionally name their source.
    composePopover(() => {
      renderSnapshotPopover(snapshot, options?.snapshotSource)
    })
  }

  /** No context figures yet, but usage exists: an empty ring anchors the usage hover. */
  function renderUsageOnly(usage: FooterUsageTooltipModel, options?: ContextWheelOptions): void {
    root.hidden = false
    fill.setAttribute('stroke-dasharray', `0 ${String(CIRCUMFERENCE)}`)
    setFillState(0)
    popoverActive = true
    root.tabIndex = 0
    const usageLine = options?.usageLine?.trim() ?? usage.header
    root.title = usageLine
    root.setAttribute('aria-label', usageLine)
    composePopover(null)
  }

  function update(
    snapshot: ContextSnapshot | null | undefined,
    running: boolean,
    options?: ContextWheelOptions,
  ): void {
    currentUsage = options?.usage ?? null
    const breakdown = options?.breakdown
    if (
      !running &&
      options?.breakdownRing &&
      breakdown &&
      breakdown.totalTokens > 0 &&
      breakdown.contextWindow > 0
    ) {
      renderBreakdown(breakdown)
      root.classList.add('is-interactive')
      restoreEngagedPopover()
      return
    }

    resetToSnapshotMode()
    if (!snapshot || snapshot.conversationBudget <= 0) {
      if (currentUsage) renderUsageOnly(currentUsage, options)
      else root.hidden = true
    } else {
      renderSnapshot(snapshot, running, options)
    }
    root.classList.toggle('is-interactive', popoverActive && !root.hidden)
    restoreEngagedPopover()
  }

  return { root, update }
}
