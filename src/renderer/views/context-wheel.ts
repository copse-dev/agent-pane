import {
  FORCE_TEXT_FILL_RATIO,
  SOFT_NUDGE_FILL_RATIO,
} from '@shared/agent/agent-loop-escalation.ts'
import type { ContextSnapshot } from '@shared/types'

const RADIUS = 6
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

function fillClass(ratio: number): string {
  if (ratio >= FORCE_TEXT_FILL_RATIO) return 'is-critical'
  if (ratio >= SOFT_NUDGE_FILL_RATIO) return 'is-warn'
  return 'is-normal'
}

export function createContextWheel(): {
  root: HTMLElement
  update: (snapshot: ContextSnapshot | null | undefined, running: boolean) => void
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
  fill.setAttribute('stroke-linecap', 'round')
  fill.setAttribute('transform', 'rotate(-90 8 8)')
  fill.classList.add('context-wheel-fill')

  svg.append(track, fill)
  root.append(svg)

  function update(snapshot: ContextSnapshot | null | undefined, running: boolean): void {
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
    root.classList.remove('is-normal', 'is-warn', 'is-critical')
    root.classList.add(fillClass(ratio))
    root.title = `Context: ${formatTokenCount(snapshot.conversationTokens)} / ${formatTokenCount(snapshot.conversationBudget)} (${pct}%)`
    root.setAttribute(
      'aria-label',
      `Context ${pct}% used, ${formatTokenCount(snapshot.conversationTokens)} of ${formatTokenCount(snapshot.conversationBudget)} tokens`,
    )
  }

  return { root, update }
}
