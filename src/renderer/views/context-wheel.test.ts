import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { composeContextBreakdown } from '@copse/agent/context-breakdown.ts'
import { buildFooterUsageTooltip } from '@shared/usage/footer-usage-tooltip.ts'
import { CONTEXT_DANGER_RATIO, CONTEXT_WARN_RATIO, createContextWheel } from './context-wheel.ts'

// Component-level port of tests/e2e/context-breakdown.e2e.ts. That spec is
// CI-quarantined for runner OOM, yet what it asserts — the breakdown ring on a
// fresh thread (has-breakdown class, a "NN%" aria-label, ≥2 arc segments) and the
// hover popover listing the named parts ("System prompt", "Your message") — is
// pure DOM rendered by the real context-wheel view from a ContextBreakdown.
// The breakdown itself is computed in main over IPC (api.agent.estimateContext),
// which stays e2e; here we feed the view the same shape via the real shared
// composeContextBreakdown builder, so the segment labels are authoritative.

afterEach(() => {
  document.body.replaceChildren()
})

describe('context wheel breakdown (component)', () => {
  it('uses the hover percentage when snapshot and breakdown figures differ', () => {
    const wheel = createContextWheel()
    const breakdown = composeContextBreakdown({ system: 1800, history: 5000 }, 200_000)
    wheel.update(
      {
        contextWindow: 200_000,
        conversationBudget: 100_000,
        conversationTokens: 50_000,
        fillRatio: 0.5,
        updatedAt: 1,
      },
      false,
      { breakdown, breakdownRing: false },
    )
    assert.equal(wheel.root.title, 'Context: 6.8k / 200.0k (3%)')
    assert.equal(wheel.root.getAttribute('aria-label'), 'Context 3% used, 6.8k of 200.0k tokens')
    assert.equal(
      wheel.root.querySelector('.context-wheel-popover-header')?.textContent,
      'Context · 6.8k / 200.0k (3%)',
    )
    // The measured ring still represents the live snapshot.
    assert.equal(
      wheel.root.querySelector('.context-wheel-fill')?.getAttribute('stroke-dasharray'),
      `${String(Math.PI * 6)} ${String(2 * Math.PI * 6)}`,
    )
  })

  it('shows the default-context breakdown ring on a fresh thread', () => {
    const wheel = createContextWheel()
    document.body.append(wheel.root)

    // A fresh thread's default context: the system prompt plus the tool schemas,
    // before the user has typed anything. Two non-empty parts → ≥2 ring arcs.
    const breakdown = composeContextBreakdown({ system: 1800, tools: 1200 }, 200_000)
    wheel.update(null, false, { breakdown, breakdownRing: true })

    assert.equal(wheel.root.hidden, false)
    assert.ok(wheel.root.classList.contains('has-breakdown'))
    // The ring carries the fill; the percentage lives in the hover and the aria-label.
    assert.equal(wheel.root.querySelector('.context-wheel-label'), null)
    assert.match(wheel.root.getAttribute('aria-label') ?? '', /\d+%/)

    const arcs = wheel.root.querySelectorAll('.context-wheel g circle')
    assert.ok(arcs.length >= 2, `expected ≥2 arc segments, got ${String(arcs.length)}`)
  })

  it('adds a "Your message" segment and reveals the hover breakdown', () => {
    const wheel = createContextWheel()
    document.body.append(wheel.root)

    // Once the user types, the estimate gains a "message" part on top of the
    // default system prompt — mirrors the e2e typing into the composer.
    const breakdown = composeContextBreakdown({ system: 1800, message: 60 }, 200_000)
    wheel.update(null, false, { breakdown, breakdownRing: true })

    const popover = wheel.root.querySelector<HTMLElement>('.context-wheel-popover')
    assert.ok(popover)
    // Hidden until hovered/focused, just like the e2e (moveTo → popover shows).
    assert.equal(popover.hidden, true)

    wheel.root.dispatchEvent(new Event('mouseenter'))
    assert.equal(popover.hidden, false)

    assert.match(popover.textContent, /System prompt/)
    assert.match(popover.textContent, /Your message/)
  })

  it('keeps the breakdown on hover for an already-run primary chat (live snapshot)', () => {
    const wheel = createContextWheel()
    document.body.append(wheel.root)

    // An existing chat has a measured live snapshot. The wheel shows the live
    // fill ring (not the multi-arc breakdown ring), but hovering must still
    // reveal the part-by-part breakdown of the primary chat (issue #482).
    const breakdown = composeContextBreakdown({ system: 1800, history: 5000 }, 200_000)
    const snapshot = {
      contextWindow: 200_000,
      conversationBudget: 200_000,
      conversationTokens: 6800,
      fillRatio: 0.034,
      updatedAt: Date.now(),
    }
    wheel.update(snapshot, false, { breakdown, breakdownRing: false })

    assert.equal(wheel.root.hidden, false)
    // Live snapshot ring, not the multi-arc breakdown ring.
    assert.ok(!wheel.root.classList.contains('has-breakdown'))
    assert.equal(wheel.root.querySelectorAll('.context-wheel g circle').length, 0)

    const popover = wheel.root.querySelector<HTMLElement>('.context-wheel-popover')
    assert.ok(popover)
    assert.equal(popover.hidden, true)
    wheel.root.dispatchEvent(new Event('mouseenter'))
    assert.equal(popover.hidden, false)
    assert.match(popover.textContent, /System prompt/)
    assert.match(popover.textContent, /Conversation/)
  })

  it('falls back to the snapshot aggregate when no breakdown is provided', () => {
    const wheel = createContextWheel()
    document.body.append(wheel.root)

    // Subagent and remote-agent windows report only a live snapshot and no
    // breakdown. The wheel used to be inert on hover in that state; it now
    // shows the aggregate it is already drawing, with no source note.
    const snapshot = {
      contextWindow: 200_000,
      conversationBudget: 200_000,
      conversationTokens: 6800,
      fillRatio: 0.034,
      updatedAt: Date.now(),
    }
    wheel.update(snapshot, false, { breakdown: null, breakdownRing: false })

    const popover = wheel.root.querySelector<HTMLElement>('.context-wheel-popover')
    assert.ok(popover)
    assert.equal(popover.hidden, true)
    wheel.root.dispatchEvent(new Event('mouseenter'))
    assert.equal(popover.hidden, false)
    assert.match(popover.textContent, /Context · 6\.8k \/ 200\.0k \(3%\)/)
    assert.equal(popover.querySelectorAll('.context-wheel-popover-note').length, 0)
  })

  it('keeps a hover aggregate while the agent is running', () => {
    const wheel = createContextWheel()
    document.body.append(wheel.root)

    // Mid-run the caller passes `breakdown: null` on purpose — the pre-send
    // estimate describes the *next* prompt, so the live snapshot is the
    // authoritative source. That used to leave the wheel with nothing on hover
    // for the whole run; the aggregate needs no estimate to show.
    const snapshot = {
      contextWindow: 200_000,
      conversationBudget: 180_000,
      conversationTokens: 54_000,
      fillRatio: 0.3,
      updatedAt: Date.now(),
    }
    wheel.update(snapshot, true, { breakdown: null, breakdownRing: false })

    const popover = wheel.root.querySelector<HTMLElement>('.context-wheel-popover')
    assert.ok(popover)
    wheel.root.dispatchEvent(new Event('mouseenter'))
    assert.equal(popover.hidden, false)
    assert.match(popover.textContent, /Context · 54\.0k \/ 180\.0k \(30%\)/)
  })

  it('drops the popover again when the snapshot goes away', () => {
    const wheel = createContextWheel()
    document.body.append(wheel.root)

    wheel.update(
      {
        contextWindow: 200_000,
        conversationBudget: 180_000,
        conversationTokens: 54_000,
        fillRatio: 0.3,
        updatedAt: Date.now(),
      },
      true,
      { breakdown: null, breakdownRing: false },
    )
    wheel.root.dispatchEvent(new Event('mouseenter'))
    const popover = wheel.root.querySelector<HTMLElement>('.context-wheel-popover')
    assert.ok(popover)
    assert.equal(popover.hidden, false)

    // A thread with no usable snapshot hides the wheel outright; hovering the
    // stale node must not resurrect the previous thread's numbers.
    wheel.update(null, false, { breakdown: null, breakdownRing: false })
    assert.equal(wheel.root.hidden, true)
    wheel.root.dispatchEvent(new Event('mouseenter'))
    assert.equal(popover.hidden, true)
  })

  it('shows an aggregate-only popover for an ACP-reported snapshot', () => {
    const wheel = createContextWheel()
    document.body.append(wheel.root)

    const snapshot = {
      contextWindow: 200_000,
      conversationBudget: 200_000,
      conversationTokens: 80_000,
      fillRatio: 0.4,
      updatedAt: Date.now(),
    }
    wheel.update(snapshot, false, {
      breakdown: null,
      breakdownRing: false,
      snapshotSource: 'Reported by ACP agent',
    })

    const popover = wheel.root.querySelector<HTMLElement>('.context-wheel-popover')
    assert.ok(popover)
    assert.equal(popover.hidden, true)
    wheel.root.dispatchEvent(new Event('mouseenter'))
    assert.equal(popover.hidden, false)
    assert.match(popover.textContent, /Context · 80\.0k \/ 200\.0k \(40%\)/)
    assert.match(popover.textContent, /Reported by ACP agent/)
    assert.equal(popover.querySelectorAll('.context-wheel-popover-row').length, 0)
  })
})

describe('context wheel fill state', () => {
  function snapshotAt(
    fillRatio: number,
  ): Parameters<ReturnType<typeof createContextWheel>['update']>[0] {
    return {
      contextWindow: 200_000,
      conversationBudget: 200_000,
      conversationTokens: Math.round(fillRatio * 200_000),
      fillRatio,
      updatedAt: Date.now(),
    }
  }

  function fillClasses(ratio: number): string[] {
    const wheel = createContextWheel()
    document.body.append(wheel.root)
    wheel.update(snapshotAt(ratio), false, { breakdown: null, breakdownRing: false })
    const fill = wheel.root.querySelector('.context-wheel-fill')
    assert.ok(fill)
    return [...fill.classList].filter((name) => name.startsWith('is-'))
  }

  it('stays neutral below the warning threshold', () => {
    assert.deepEqual(fillClasses(CONTEXT_WARN_RATIO - 0.01), [])
  })

  it('turns amber from the warning threshold up to the danger threshold', () => {
    assert.deepEqual(fillClasses(CONTEXT_WARN_RATIO), ['is-warn'])
    assert.deepEqual(fillClasses(CONTEXT_DANGER_RATIO - 0.01), ['is-warn'])
  })

  it('turns red from the danger threshold', () => {
    assert.deepEqual(fillClasses(CONTEXT_DANGER_RATIO), ['is-danger'])
    assert.deepEqual(fillClasses(1), ['is-danger'])
  })

  it('clears the state when the thread drops back below the threshold', () => {
    const wheel = createContextWheel()
    document.body.append(wheel.root)
    wheel.update(snapshotAt(0.97), false, { breakdown: null, breakdownRing: false })
    wheel.update(snapshotAt(0.3), false, { breakdown: null, breakdownRing: false })
    const fill = wheel.root.querySelector('.context-wheel-fill')
    assert.ok(fill)
    assert.equal(fill.classList.contains('is-danger'), false)
    assert.equal(fill.classList.contains('is-warn'), false)
  })

  it('keeps the track solid for agent-reported figures', () => {
    const wheel = createContextWheel()
    document.body.append(wheel.root)
    wheel.update(snapshotAt(0.4), false, {
      breakdown: null,
      breakdownRing: false,
      snapshotSource: 'Reported by ACP agent',
    })
    const track = wheel.root.querySelector('.context-wheel-track')
    assert.ok(track)
    assert.equal(track.getAttribute('stroke-dasharray'), null)
    assert.equal(wheel.root.classList.contains('is-reported'), false)
  })
})

describe('context wheel combined usage hover', () => {
  const usage = buildFooterUsageTooltip(
    { inputTokens: 14_200, outputTokens: 3500, estimated: false },
    {
      model: 'claude-sonnet-4-6',
      messages: [],
      measuredUsage: { inputTokens: 14_200, outputTokens: 3500 },
    },
  )
  const snapshot = {
    contextWindow: 200_000,
    conversationBudget: 200_000,
    conversationTokens: 136_000,
    fillRatio: 0.68,
    updatedAt: Date.now(),
  }

  it('shows the context section, a divider, then the usage rows in one popover', () => {
    const wheel = createContextWheel()
    document.body.append(wheel.root)
    wheel.update(snapshot, false, { breakdown: null, breakdownRing: false, usage })

    const popover = wheel.root.querySelector<HTMLElement>('.context-wheel-popover')
    assert.ok(popover)
    wheel.root.dispatchEvent(new Event('mouseenter'))
    assert.equal(popover.hidden, false)

    const text = popover.textContent
    assert.match(text, /Context · 136\.0k \/ 200\.0k \(68%\)/)
    assert.match(text, /Usage · 17\.7k tokens/)
    assert.match(text, /Input\s*14\.2k/)
    assert.ok(text.indexOf('Context ·') < text.indexOf('Usage ·'))
    assert.equal(popover.querySelectorAll('.footer-usage-popover-divider').length, 1)
  })

  it('keeps an empty ring visible for usage with no context figures', () => {
    const wheel = createContextWheel()
    document.body.append(wheel.root)
    wheel.update(null, false, { breakdown: null, breakdownRing: false, usage })

    assert.equal(wheel.root.hidden, false)
    const fill = wheel.root.querySelector('.context-wheel-fill')
    assert.match(fill?.getAttribute('stroke-dasharray') ?? '', /^0 /)

    const popover = wheel.root.querySelector<HTMLElement>('.context-wheel-popover')
    assert.ok(popover)
    wheel.root.dispatchEvent(new Event('mouseenter'))
    assert.equal(popover.hidden, false)
    assert.match(popover.textContent, /Usage · 17\.7k tokens/)
    // Nothing to put above the divider, so no divider either.
    assert.equal(popover.querySelectorAll('.footer-usage-popover-divider').length, 0)
  })

  it('stays open across a re-render while the pointer is on it', () => {
    // The footer re-renders under an open hover — streaming, a usage change, the
    // async context estimate landing. That must not close it.
    const wheel = createContextWheel()
    document.body.append(wheel.root)
    wheel.update(snapshot, false, { breakdown: null, breakdownRing: false, usage })
    const popover = wheel.root.querySelector<HTMLElement>('.context-wheel-popover')
    assert.ok(popover)
    wheel.root.dispatchEvent(new Event('mouseenter'))
    assert.equal(popover.hidden, false)

    wheel.update(snapshot, false, { breakdown: null, breakdownRing: false, usage })
    assert.equal(popover.hidden, false)

    wheel.root.dispatchEvent(new Event('mouseleave'))
    assert.equal(popover.hidden, true)
    // After the pointer has left, a re-render must not reopen it.
    wheel.update(snapshot, false, { breakdown: null, breakdownRing: false, usage })
    assert.equal(popover.hidden, true)
  })

  it('does not reopen for a pointer that is still there once the wheel has nothing to show', () => {
    const wheel = createContextWheel()
    document.body.append(wheel.root)
    wheel.update(snapshot, false, { breakdown: null, breakdownRing: false, usage })
    const popover = wheel.root.querySelector<HTMLElement>('.context-wheel-popover')
    assert.ok(popover)
    wheel.root.dispatchEvent(new Event('mouseenter'))
    wheel.update(null, false, { breakdown: null, breakdownRing: false, usage: null })
    assert.equal(wheel.root.hidden, true)
    assert.equal(popover.hidden, true)
  })

  it('does not leak the previous usage into a thread without any', () => {
    const wheel = createContextWheel()
    document.body.append(wheel.root)
    wheel.update(null, false, { breakdown: null, breakdownRing: false, usage })
    wheel.update(null, false, { breakdown: null, breakdownRing: false, usage: null })
    assert.equal(wheel.root.hidden, true)
  })
})
