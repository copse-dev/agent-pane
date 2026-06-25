import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ContextBreakdown } from '@shared/types'
import { createContextWheel } from './context-wheel.ts'

// Component-level port of tests/e2e/context-breakdown.e2e.ts (CI-quarantined: its
// Electron renderer OOM-crashes the 2-core/7GB runner, so it ran nowhere). The
// e2e asserts how the composer context wheel RENDERS a breakdown — the
// `has-breakdown` ring with a `%` label and one arc per segment, and the hover
// popover listing each segment by label. None of that needs a browser: the wheel
// is a self-contained DOM factory (`createContextWheel`) driven by a
// `ContextBreakdown`, and the popover reveal is a JS `mouseenter` listener (not
// CSS `:hover`), so it fires in happy-dom. The breakdown COMPUTATION (default
// segments, the "Your message" segment from a draft, the labels) is the pure
// `composeContextBreakdown`, already covered by
// src/shared/agent/context-breakdown.test.ts — together they replace the e2e.

const contextWindow = 200_000

function breakdown(segments: ContextBreakdown['segments']): ContextBreakdown {
  return {
    segments,
    totalTokens: segments.reduce((sum, s) => sum + s.tokens, 0),
    contextWindow,
  }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('context wheel breakdown render (component)', () => {
  it('renders the breakdown ring with a percentage label and one arc per segment', () => {
    const { root, update } = createContextWheel()
    document.body.append(root)

    update(null, false, {
      breakdown: breakdown([
        { key: 'system', label: 'System prompt', tokens: 1200 },
        { key: 'tools', label: 'Tools', tokens: 800 },
      ]),
    })

    // e2e: wheel gains `has-breakdown`, label matches /\d+%/, and `g circle`
    // (the per-segment arcs, distinct from the track/fill circles) is >= 2.
    assert.ok(root.classList.contains('has-breakdown'))
    assert.match(root.querySelector('.context-wheel-label')?.textContent ?? '', /\d+%/)
    assert.ok(root.querySelectorAll('g circle').length >= 2)
  })

  it('reveals a hover popover listing each segment, including "Your message"', () => {
    const { root, update } = createContextWheel()
    document.body.append(root)

    update(null, false, {
      breakdown: breakdown([
        { key: 'system', label: 'System prompt', tokens: 1200 },
        { key: 'tools', label: 'Tools', tokens: 800 },
        { key: 'message', label: 'Your message', tokens: 64 },
      ]),
    })

    const popover = root.querySelector<HTMLElement>('.context-wheel-popover')
    assert.ok(popover, 'expected a popover element')
    // Hidden until hovered; the reveal is a JS mouseenter listener.
    assert.equal(popover.hidden, true)
    root.dispatchEvent(new Event('mouseenter'))
    assert.equal(popover.hidden, false)

    // e2e: popover text includes the System prompt and Your message segments.
    assert.match(popover.textContent ?? '', /System prompt/)
    assert.match(popover.textContent ?? '', /Your message/)
  })
})
