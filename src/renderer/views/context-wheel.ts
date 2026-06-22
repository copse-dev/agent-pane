import type { ContextSnapshot } from '@shared/types'

const RADIUS = 6
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

export function createContextWheel(): {
  root: HTMLElement
  update: (
    snapshot: ContextSnapshot | null | undefined,
    running: boolean,
    options?: { usageLine?: string | null },
  ) => void
} {
  const root = document.createElement('div')
  root.className = 'context-wheel'
  root.hidden = true

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('aria-hidden', 'true')

  const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  track.setAttribute('cx', '8')
  track.setAttribute('cy', '8')
  track.setAttribute('r', String(RADIUS))
  track.setAttribute('fill', 'none')
  track.setAttribute('stroke-width', '2')
  track.classList.add('context-wheel-track')

  const fill = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  fill.setAttribute('cx', '8')
  fill.setAttribute('cy', '8')
  fill.setAttribute('r', String(RADIUS))
  fill.setAttribute('fill', 'none')
  fill.setAttribute('stroke-width', '2')
  fill.setAttribute('transform', 'rotate(-90 8 8)')
  fill.classList.add('context-wheel-fill')

  const label = document.createElement('span')
  label.className = 'context-wheel-label'

  svg.append(track, fill)
  root.append(svg, label)

  function update(
    snapshot: ContextSnapshot | null | undefined,
    running: boolean,
    options?: { usageLine?: string | null },
  ): void {
    if (!snapshot || snapshot.conversationBudget <= 0) {
      root.hidden = true
      return
    }

    const ratio = Math.min(1, Math.max(0, snapshot.fillRatio))
    const pct = Math.round(ratio * 100)
    const visible = running || ratio > 0.01
    root.hidden = !visible
    if (!visible) return

    fill.setAttribute('stroke-dasharray', `${ratio * CIRCUMFERENCE} ${CIRCUMFERENCE}`)
    label.textContent = `${pct}%`
    const contextLine = `Context: ${formatTokenCount(snapshot.conversationTokens)} / ${formatTokenCount(snapshot.conversationBudget)} (${pct}%)`
    const usageLine = options?.usageLine?.trim()
    root.title = usageLine ? `${contextLine}\n${usageLine}` : contextLine
    const ariaUsage = usageLine ? `; ${usageLine}` : ''
    root.setAttribute(
      'aria-label',
      `Context ${pct}% used, ${formatTokenCount(snapshot.conversationTokens)} of ${formatTokenCount(snapshot.conversationBudget)} tokens${ariaUsage}`,
    )
  }

  return { root, update }
}
