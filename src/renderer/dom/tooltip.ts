/**
 * App-wide hover/focus tooltips.
 *
 * Icon-only chrome (the titlebar panel toggles, pane header buttons, the PR
 * lifecycle glyphs) carries an `aria-label` for screen readers but nothing a
 * sighted user can read. Native `title` fills that gap badly: ~1s delay, OS
 * chrome that ignores the app theme, and no control over placement.
 *
 * So: one delegated controller and one fixed-position node for the whole
 * window. Mark any element with `data-tooltip="…"` (optionally
 * `data-tooltip-placement="top|bottom|left|right"`) and it gets a small styled
 * label on hover and on keyboard focus. The tooltip is `aria-hidden` — the
 * accessible name still comes from `aria-label`/text, so nothing is announced
 * twice.
 */

const TOOLTIP_ID = 'app-tooltip'
const SHOW_DELAY_MS = 350
/**
 * Moving between two tooltipped controls within this window re-shows without
 * the delay, so scrubbing along the titlebar reads as one continuous surface
 * rather than a series of waits.
 */
const CHAIN_WINDOW_MS = 400
/** A focus landing this soon after a pointerdown came from that click, not the keyboard. */
const POINTER_FOCUS_WINDOW_MS = 300

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right'

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

interface Size {
  width: number
  height: number
}

export interface TooltipPositionInput {
  anchor: Rect
  tip: Size
  viewport: Size
  preferred: TooltipPlacement
  /** Space between the anchor edge and the tooltip. */
  gap?: number
  /** Minimum distance kept from every viewport edge. */
  pad?: number
}

export interface TooltipPosition {
  left: number
  top: number
  placement: TooltipPlacement
}

const OPPOSITE: Record<TooltipPlacement, TooltipPlacement> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
}

function fits(placement: TooltipPlacement, input: Required<TooltipPositionInput>): boolean {
  const { anchor, tip, viewport, gap, pad } = input
  switch (placement) {
    case 'top':
      return anchor.top - gap - tip.height >= pad
    case 'bottom':
      return anchor.top + anchor.height + gap + tip.height <= viewport.height - pad
    case 'left':
      return anchor.left - gap - tip.width >= pad
    case 'right':
      return anchor.left + anchor.width + gap + tip.width <= viewport.width - pad
  }
}

function clamp(value: number, min: number, max: number): number {
  // A tooltip wider than the viewport has max < min; pinning to `min` keeps its
  // readable edge on screen instead of pushing it off the other side.
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

/**
 * Place a tooltip against its anchor: keep the preferred side when it fits,
 * flip to the opposite side when it doesn't, and clamp the cross axis so the
 * label never leaves the viewport. Pure so the geometry is testable without a
 * layout engine.
 */
export function computeTooltipPosition(input: TooltipPositionInput): TooltipPosition {
  const resolved: Required<TooltipPositionInput> = {
    ...input,
    gap: input.gap ?? 6,
    pad: input.pad ?? 6,
  }
  const { anchor, tip, viewport, gap, pad } = resolved

  let placement = resolved.preferred
  if (!fits(placement, resolved) && fits(OPPOSITE[placement], resolved)) {
    placement = OPPOSITE[placement]
  }

  let left: number
  let top: number
  if (placement === 'top' || placement === 'bottom') {
    left = anchor.left + anchor.width / 2 - tip.width / 2
    top = placement === 'top' ? anchor.top - gap - tip.height : anchor.top + anchor.height + gap
  } else {
    top = anchor.top + anchor.height / 2 - tip.height / 2
    left = placement === 'left' ? anchor.left - gap - tip.width : anchor.left + anchor.width + gap
  }

  return {
    left: clamp(left, pad, viewport.width - tip.width - pad),
    top: clamp(top, pad, viewport.height - tip.height - pad),
    placement,
  }
}

/**
 * Set (or clear, with `null`) an element's tooltip. Use for labels that change
 * with state; static ones are cheaper written as a `data-tooltip` attribute in
 * the `el()` call.
 */
export function setTooltip(node: Element, text: string | null): void {
  const trimmed = text?.trim()
  const next = trimmed === undefined || trimmed === '' ? null : trimmed
  if (next) node.setAttribute('data-tooltip', next)
  else node.removeAttribute('data-tooltip')

  // State-bearing anchors (CI status, pending-diff counts, branch chips) can
  // change while the pointer remains over them. Keep the visible label and its
  // geometry in sync instead of leaving a stale snapshot until pointerout.
  if (activeAnchor === node) {
    if (next) show(node)
    else hide()
  }
}

let tipNode: HTMLElement | null = null
let activeAnchor: Element | null = null
let showTimer: ReturnType<typeof setTimeout> | null = null
let lastHiddenAt = 0
let lastPointerDownAt = 0
let uninstall: (() => void) | null = null
/** `title` stashed while our tooltip is up, so the OS one can't stack on it. */
const suppressedTitles = new WeakMap<Element, string>()

function ensureTipNode(): HTMLElement {
  if (tipNode?.isConnected) return tipNode
  const node = document.createElement('div')
  node.id = TOOLTIP_ID
  node.className = 'app-tooltip'
  node.setAttribute('role', 'tooltip')
  // Purely visual: the anchor's aria-label already names it, so announcing the
  // tooltip too would double up.
  node.setAttribute('aria-hidden', 'true')
  node.hidden = true
  document.body.append(node)
  tipNode = node
  return node
}

function tooltipTextOf(node: Element): string {
  return node.getAttribute('data-tooltip')?.trim() ?? ''
}

function placementOf(node: Element): TooltipPlacement {
  const raw = node.getAttribute('data-tooltip-placement')
  if (raw === 'top' || raw === 'bottom' || raw === 'left' || raw === 'right') return raw
  // Most tooltipped chrome lives in the titlebar and pane headers, where there
  // is room below and none above.
  return 'bottom'
}

function restoreTitle(node: Element): void {
  const stashed = suppressedTitles.get(node)
  if (stashed === undefined) return
  suppressedTitles.delete(node)
  node.setAttribute('title', stashed)
}

function position(node: HTMLElement, anchor: Element): void {
  const rect = anchor.getBoundingClientRect()
  const tip = node.getBoundingClientRect()
  const { left, top, placement } = computeTooltipPosition({
    anchor: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    tip: { width: tip.width, height: tip.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    preferred: placementOf(anchor),
  })
  node.dataset['placement'] = placement
  node.style.left = `${String(Math.round(left))}px`
  node.style.top = `${String(Math.round(top))}px`
}

function show(anchor: Element): void {
  const text = tooltipTextOf(anchor)
  if (!text || !anchor.isConnected) return

  const node = ensureTipNode()
  activeAnchor = anchor
  node.textContent = text
  node.hidden = false

  // A stale `title` would surface the OS tooltip on top of ours a second later.
  const title = anchor.getAttribute('title')
  if (title !== null) {
    suppressedTitles.set(anchor, title)
    anchor.removeAttribute('title')
  }

  // Measure once laid out, then place. Both reads happen after `hidden` is
  // cleared so the tooltip has real dimensions.
  position(node, anchor)
}

function hide(): void {
  if (showTimer) {
    clearTimeout(showTimer)
    showTimer = null
  }
  if (activeAnchor) {
    restoreTitle(activeAnchor)
    activeAnchor = null
    lastHiddenAt = Date.now()
  }
  if (tipNode) {
    tipNode.hidden = true
    tipNode.textContent = ''
  }
}

function scheduleShow(anchor: Element, immediate: boolean): void {
  if (activeAnchor === anchor) return
  hide()
  // Chained hovers skip the delay; a cold hover waits so tooltips don't chase
  // the pointer as it crosses the chrome on its way somewhere else.
  const delay = immediate || Date.now() - lastHiddenAt < CHAIN_WINDOW_MS ? 0 : SHOW_DELAY_MS
  if (delay === 0) {
    show(anchor)
    return
  }
  showTimer = setTimeout(() => {
    showTimer = null
    show(anchor)
  }, delay)
}

function anchorFor(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null
  // `Element`, not `HTMLElement`: SVG glyphs (the PR lifecycle icons) carry
  // tooltips too, and those are SVGElements.
  const found = target.closest('[data-tooltip]')
  return found && tooltipTextOf(found) ? found : null
}

/**
 * Install the delegated tooltip listeners on this window. Idempotent — the
 * second call returns the same teardown without double-binding.
 */
export function installTooltips(): () => void {
  if (uninstall) return uninstall

  const onPointerOver = (e: PointerEvent): void => {
    // Touch "hover" is a synthesized pre-tap event; a tooltip there just
    // covers what the user is about to press.
    if (e.pointerType === 'touch') return
    const anchor = anchorFor(e.target)
    if (!anchor) {
      if (activeAnchor) hide()
      return
    }
    scheduleShow(anchor, false)
  }

  const onPointerOut = (e: PointerEvent): void => {
    if (!activeAnchor && !showTimer) return
    const next = e.relatedTarget
    // Moving within the anchor's own subtree is not a leave.
    if (next instanceof Node && anchorFor(next) === anchorFor(e.target)) return
    hide()
  }

  const onFocusIn = (e: FocusEvent): void => {
    const anchor = anchorFor(e.target)
    if (!anchor) {
      if (activeAnchor) hide()
      return
    }
    // Only keyboard focus earns a tooltip. A click focuses the button too, and
    // there the label would linger over whatever the click just opened — so a
    // focus that trails a pointerdown is treated as mouse-driven and skipped.
    if (Date.now() - lastPointerDownAt < POINTER_FOCUS_WINDOW_MS) return
    scheduleShow(anchor, true)
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') hide()
  }

  const dismiss = (): void => {
    hide()
  }

  const onPointerDown = (): void => {
    lastPointerDownAt = Date.now()
    hide()
  }

  document.addEventListener('pointerover', onPointerOver, true)
  document.addEventListener('pointerout', onPointerOut, true)
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('focusout', dismiss, true)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeyDown, true)
  // Capture-phase scroll catches scrolling panes, which don't bubble.
  document.addEventListener('scroll', dismiss, true)
  window.addEventListener('blur', dismiss)
  // A resize invalidates the viewport-relative geometry. Dismiss and let the
  // next pointer/focus event place it against the new window bounds.
  window.addEventListener('resize', dismiss)

  uninstall = (): void => {
    uninstall = null
    hide()
    document.removeEventListener('pointerover', onPointerOver, true)
    document.removeEventListener('pointerout', onPointerOut, true)
    document.removeEventListener('focusin', onFocusIn, true)
    document.removeEventListener('focusout', dismiss, true)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('scroll', dismiss, true)
    window.removeEventListener('blur', dismiss)
    window.removeEventListener('resize', dismiss)
    tipNode?.remove()
    tipNode = null
  }
  return uninstall
}

/** Test / teardown helper — dismisses any visible tooltip. */
export function dismissTooltip(): void {
  hide()
}
