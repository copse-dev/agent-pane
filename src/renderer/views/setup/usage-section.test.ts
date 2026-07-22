import '../../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import type { ProviderPlanResult } from '@copse/plan-usage'
import {
  claudeReasonNeedsLogin,
  createClaudeSignInHandler,
  renderPlanProvider,
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
