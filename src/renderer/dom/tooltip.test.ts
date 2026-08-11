import '../../../tests/setup-dom.ts'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { computeTooltipPosition, dismissTooltip, installTooltips, setTooltip } from './tooltip.ts'

const VIEWPORT = { width: 1000, height: 700 }

describe('computeTooltipPosition', () => {
  it('centers below the anchor when the preferred side fits', () => {
    const pos = computeTooltipPosition({
      anchor: { left: 400, top: 10, width: 40, height: 24 },
      tip: { width: 80, height: 20 },
      viewport: VIEWPORT,
      preferred: 'bottom',
    })
    assert.equal(pos.placement, 'bottom')
    assert.equal(pos.left, 380)
    assert.equal(pos.top, 40)
  })

  it('flips to the opposite side when the preferred one has no room', () => {
    const pos = computeTooltipPosition({
      anchor: { left: 400, top: 4, width: 40, height: 24 },
      tip: { width: 80, height: 20 },
      viewport: VIEWPORT,
      preferred: 'top',
    })
    assert.equal(pos.placement, 'bottom')
    assert.equal(pos.top, 34)
  })

  it('keeps the preferred side when neither fits', () => {
    const pos = computeTooltipPosition({
      anchor: { left: 400, top: 0, width: 40, height: 700 },
      tip: { width: 80, height: 20 },
      viewport: VIEWPORT,
      preferred: 'top',
    })
    assert.equal(pos.placement, 'top')
  })

  it('clamps the cross axis inside the viewport near an edge', () => {
    const right = computeTooltipPosition({
      anchor: { left: 970, top: 10, width: 24, height: 24 },
      tip: { width: 120, height: 20 },
      viewport: VIEWPORT,
      preferred: 'bottom',
    })
    assert.equal(right.left, 1000 - 120 - 6)

    const left = computeTooltipPosition({
      anchor: { left: 2, top: 10, width: 24, height: 24 },
      tip: { width: 120, height: 20 },
      viewport: VIEWPORT,
      preferred: 'bottom',
    })
    assert.equal(left.left, 6)
  })

  it('pins a tooltip wider than the viewport to the left pad', () => {
    const pos = computeTooltipPosition({
      anchor: { left: 100, top: 10, width: 24, height: 24 },
      tip: { width: 1200, height: 20 },
      viewport: VIEWPORT,
      preferred: 'bottom',
    })
    assert.equal(pos.left, 6)
  })
})

function hover(node: HTMLElement): void {
  node.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true }))
}

function unhover(node: HTMLElement, relatedTarget: EventTarget | null = null): void {
  node.dispatchEvent(new window.PointerEvent('pointerout', { bubbles: true, relatedTarget }))
}

function tooltipEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.app-tooltip')
}

function button(tooltip: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.setAttribute('data-tooltip', tooltip)
  document.body.append(btn)
  return btn
}

describe('installTooltips', () => {
  let uninstall: (() => void) | null = null

  // The controller is a module singleton, so its last-pointerdown / last-hide
  // timestamps outlive a test. Each test therefore starts its fake clock a
  // minute after the previous one ended, rather than rewinding to a point where
  // a prior test's pointerdown still looks recent.
  let clockBase = 1_000_000

  beforeEach(() => {
    // `Date` is faked alongside `setTimeout` because the show delay and the
    // chained-hover window both read Date.now().
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: clockBase })
    clockBase += 60_000
    uninstall = installTooltips()
  })

  afterEach(() => {
    dismissTooltip()
    uninstall?.()
    uninstall = null
    mock.timers.reset()
    document.body.replaceChildren()
  })

  it('waits out the hover delay before showing', () => {
    const btn = button('Open terminal')

    hover(btn)
    assert.equal(tooltipEl(), null)

    mock.timers.tick(400)
    const tip = tooltipEl()
    assert.ok(tip)
    assert.equal(tip.hidden, false)
    assert.equal(tip.textContent, 'Open terminal')
  })

  it('resolves the tooltip from an ancestor when an inner icon is hovered', () => {
    const btn = button('Open pull requests')
    const icon = document.createElement('span')
    btn.append(icon)

    hover(icon)
    mock.timers.tick(400)
    assert.equal(tooltipEl()?.textContent, 'Open pull requests')
  })

  it('skips the delay for a second control hovered right after the first', () => {
    const first = button('Open changes')
    const second = button('Open browser')

    hover(first)
    mock.timers.tick(400)
    assert.equal(tooltipEl()?.textContent, 'Open changes')

    unhover(first, second)
    hover(second)
    // No tick: chained hovers show immediately.
    assert.equal(tooltipEl()?.textContent, 'Open browser')
  })

  it('suppresses a native title while showing and restores it after', () => {
    const btn = button('Refresh')
    btn.setAttribute('title', 'Refresh')

    hover(btn)
    mock.timers.tick(400)
    assert.equal(btn.getAttribute('title'), null)

    unhover(btn)
    assert.equal(btn.getAttribute('title'), 'Refresh')
  })

  it('hides on pointerdown so the label does not linger over what was clicked', () => {
    const btn = button('Toggle right panel')

    hover(btn)
    mock.timers.tick(400)
    assert.equal(tooltipEl()?.hidden, false)

    btn.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }))
    assert.equal(tooltipEl()?.hidden, true)
  })

  it('refreshes an active state-bearing label and hides it when cleared', () => {
    const status = button('CI running')

    hover(status)
    mock.timers.tick(400)
    assert.equal(tooltipEl()?.textContent, 'CI running')

    setTooltip(status, 'CI passing')
    assert.equal(tooltipEl()?.textContent, 'CI passing')
    assert.equal(tooltipEl()?.hidden, false)

    setTooltip(status, null)
    assert.equal(tooltipEl()?.hidden, true)
  })

  it('dismisses on resize so stale viewport geometry is never retained', () => {
    const btn = button('Open terminal')

    hover(btn)
    mock.timers.tick(400)
    assert.equal(tooltipEl()?.hidden, false)

    window.dispatchEvent(new Event('resize'))
    assert.equal(tooltipEl()?.hidden, true)
  })

  it('shows immediately on keyboard focus and hides on blur', () => {
    const btn = button('Open changes')

    btn.dispatchEvent(new window.Event('focusin', { bubbles: true }))
    assert.equal(tooltipEl()?.textContent, 'Open changes')

    btn.dispatchEvent(new window.Event('focusout', { bubbles: true }))
    assert.equal(tooltipEl()?.hidden, true)
  })

  it('does not show on the focus a click brings with it', () => {
    const btn = button('New project')

    btn.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }))
    btn.dispatchEvent(new window.Event('focusin', { bubbles: true }))
    assert.equal(tooltipEl()?.hidden ?? true, true)
  })

  it('cancels a pending show when the pointer leaves first', () => {
    const btn = button('Open browser')
    const outside = document.createElement('div')
    document.body.append(outside)

    hover(btn)
    unhover(btn, outside)
    mock.timers.tick(400)
    assert.equal(tooltipEl()?.hidden ?? true, true)
  })

  it('ignores elements whose data-tooltip is blank', () => {
    const btn = button('   ')

    hover(btn)
    mock.timers.tick(400)
    assert.equal(tooltipEl(), null)
  })

  it('is idempotent — a second install returns the same teardown', () => {
    const second = installTooltips()
    assert.equal(second, uninstall)
  })
})

describe('setTooltip', () => {
  it('sets and clears the attribute', () => {
    const node = document.createElement('span')
    setTooltip(node, 'Merged')
    assert.equal(node.getAttribute('data-tooltip'), 'Merged')
    setTooltip(node, null)
    assert.equal(node.hasAttribute('data-tooltip'), false)
  })
})
