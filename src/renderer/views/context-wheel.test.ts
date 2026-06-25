import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { composeContextBreakdown } from '@shared/agent/context-breakdown.ts'
import { createContextWheel } from './context-wheel.ts'

// Component-level port of tests/e2e/context-breakdown.e2e.ts. That spec is
// CI-quarantined for runner OOM, yet what it asserts — the breakdown ring on a
// fresh thread (has-breakdown class, a "NN%" label, ≥2 arc segments) and the
// hover popover listing the named parts ("System prompt", "Your message") — is
// pure DOM rendered by the real context-wheel view from a ContextBreakdown.
// The breakdown itself is computed in main over IPC (api.agent.estimateContext),
// which stays e2e; here we feed the view the same shape via the real shared
// composeContextBreakdown builder, so the segment labels are authoritative.

afterEach(() => {
  document.body.replaceChildren()
})

describe('context wheel breakdown (component)', () => {
  it('shows the default-context breakdown ring on a fresh thread', () => {
    const wheel = createContextWheel()
    document.body.append(wheel.root)

    // A fresh thread's default context: the system prompt plus the tool schemas,
    // before the user has typed anything. Two non-empty parts → ≥2 ring arcs.
    const breakdown = composeContextBreakdown({ system: 1800, tools: 1200 }, 200_000)
    wheel.update(null, false, { breakdown })

    assert.equal(wheel.root.hidden, false)
    assert.ok(wheel.root.classList.contains('has-breakdown'))
    assert.match(wheel.root.querySelector('.context-wheel-label')!.textContent!, /\d+%/)

    const arcs = wheel.root.querySelectorAll('.context-wheel g circle')
    assert.ok(arcs.length >= 2, `expected ≥2 arc segments, got ${arcs.length}`)
  })

  it('adds a "Your message" segment and reveals the hover breakdown', () => {
    const wheel = createContextWheel()
    document.body.append(wheel.root)

    // Once the user types, the estimate gains a "message" part on top of the
    // default system prompt — mirrors the e2e typing into the composer.
    const breakdown = composeContextBreakdown({ system: 1800, message: 60 }, 200_000)
    wheel.update(null, false, { breakdown })

    const popover = wheel.root.querySelector<HTMLElement>('.context-wheel-popover')!
    // Hidden until hovered/focused, just like the e2e (moveTo → popover shows).
    assert.equal(popover.hidden, true)

    wheel.root.dispatchEvent(new Event('mouseenter'))
    assert.equal(popover.hidden, false)

    assert.match(popover.textContent!, /System prompt/)
    assert.match(popover.textContent!, /Your message/)
  })
})
