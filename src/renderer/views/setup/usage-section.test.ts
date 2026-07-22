import '../../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import type { ProviderPlanResult } from '@copse/plan-usage'
import type { PlanWorthItPayload } from '@shared/usage/plan-worth-it.ts'
import {
  claudeReasonNeedsLogin,
  createClaudeSignInHandler,
  renderPlanProvider,
  renderPlanWorthItSection,
} from './usage-section.ts'

function claudeUnavailable(reason: string): ProviderPlanResult {
  return { status: 'unavailable', provider: 'claude', reason }
}

describe('claudeReasonNeedsLogin', () => {
  it('matches sign-in / credential reasons a re-login would fix', () => {
    assert.equal(
      claudeReasonNeedsLogin('Claude credentials were rejected. Re-run `claude /login`.'),
      true,
    )
    assert.equal(
      claudeReasonNeedsLogin('Claude plan usage needs an OAuth token with user:profile scope.'),
      true,
    )
    assert.equal(
      claudeReasonNeedsLogin('No Claude OAuth token (sign in with `claude /login`)'),
      true,
    )
  })

  it('ignores inherent limitations that a login cannot fix', () => {
    assert.equal(
      claudeReasonNeedsLogin('Console API keys do not expose subscription plan windows'),
      false,
    )
  })
})

describe('renderPlanProvider sign-in button', () => {
  it('shows the button on a rejected Claude card and clicking runs the handler', () => {
    const host = document.createElement('div')
    let clicked = 0
    renderPlanProvider(
      host,
      claudeUnavailable('Claude credentials were rejected. Re-run `claude /login`.'),
      () => {
        clicked += 1
      },
    )
    const btn = host.querySelector<HTMLButtonElement>('.usage-plan-signin-btn')
    assert.ok(btn, 'expected a sign-in button')
    assert.match(btn.textContent, /Sign in to Claude/)
    btn.click()
    assert.equal(clicked, 1)
  })

  it('omits the button for reasons a login would not fix', () => {
    const host = document.createElement('div')
    renderPlanProvider(
      host,
      claudeUnavailable('Console API keys do not expose subscription plan windows'),
      () => {
        assert.fail('handler should not be wired')
      },
    )
    assert.equal(host.querySelector('.usage-plan-signin-btn'), null)
  })

  it('omits the button when no handler is provided', () => {
    const host = document.createElement('div')
    renderPlanProvider(
      host,
      claudeUnavailable('Claude credentials were rejected. Re-run `claude /login`.'),
      null,
    )
    assert.equal(host.querySelector('.usage-plan-signin-btn'), null)
  })

  it('never shows the button for a non-Claude provider, even on a rejection', () => {
    const host = document.createElement('div')
    const codex: ProviderPlanResult = {
      status: 'unavailable',
      provider: 'codex',
      reason: 'Codex credentials were rejected. Run `codex login` again.',
    }
    renderPlanProvider(host, codex, () => {
      assert.fail('handler should not be wired for codex')
    })
    assert.equal(host.querySelector('.usage-plan-signin-btn'), null)
  })
})

describe('createClaudeSignInHandler', () => {
  it('closes settings and requests `claude /login` in a terminal', () => {
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    const commands: string[] = []
    store.on('request_terminal_command', (cmd) => {
      commands.push(cmd)
    })
    let closed = 0
    const handler = createClaudeSignInHandler(store, () => {
      closed += 1
    })
    assert.ok(handler)
    handler()
    assert.deepEqual(commands, ['claude /login'])
    assert.equal(closed, 1)
  })

  it('returns null without a store to route through', () => {
    assert.equal(createClaudeSignInHandler(undefined), null)
  })
})

describe('renderPlanWorthItSection', () => {
  function payload(
    verdict: PlanWorthItPayload['worthIt']['verdict'],
    overrides: Partial<PlanWorthItPayload['worthIt']> = {},
  ): PlanWorthItPayload {
    return {
      worthIt: {
        verdict,
        reason: 'test reason',
        apiEquivalentBurnPerWeek: 90,
        planFeePerWeek: 23,
        monthlyFeeUsd: 100,
        feeHint: { monthlyFeeUsd: 100, label: 'Max 5x' },
        completedWeeklyCount: 2,
        inferenceFrontierNote: null,
        ...overrides,
      },
      windowExhaustion: [],
      historySampleCount: 2,
      completedWeeklyCount: 2,
    }
  }

  it('renders the verdict card and wires the inference control', () => {
    const host = document.createElement('div')
    let inferred = 0
    renderPlanWorthItSection(host, payload('worth_it'), null, {
      onFeeChange: () => undefined,
      onShowInference: () => {
        inferred += 1
      },
    })
    assert.equal(host.querySelector('.usage-worth-card')?.getAttribute('data-verdict'), 'worth_it')
    assert.match(host.querySelector('.usage-worth-verdict')?.textContent ?? '', /Worth it/)
    const feeInput = host.querySelector<HTMLInputElement>('#usage-worth-fee-input')
    assert.ok(feeInput)
    assert.equal(feeInput.value, '100')
    host.querySelector<HTMLButtonElement>('.usage-worth-inference-btn')?.click()
    assert.equal(inferred, 1)
  })

  it('shows the empty-history copy', () => {
    const host = document.createElement('div')
    renderPlanWorthItSection(
      host,
      payload('insufficient_history', {
        reason: 'Need a couple of completed weekly windows',
        monthlyFeeUsd: null,
        apiEquivalentBurnPerWeek: null,
        completedWeeklyCount: 0,
      }),
      null,
      { onFeeChange: () => undefined, onShowInference: () => undefined },
    )
    assert.equal(
      host.querySelector('.usage-worth-card')?.getAttribute('data-verdict'),
      'insufficient_history',
    )
    assert.match(host.querySelector('.usage-worth-reason')?.textContent ?? '', /completed weekly/)
  })
})
