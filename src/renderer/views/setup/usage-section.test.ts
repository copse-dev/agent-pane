import '../../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import type { ProviderPlanResult } from '@copse/plan-usage'
import type { PlanWorthItPayload } from '@shared/usage/plan-worth-it.ts'
import type { ModelUsageBreakdown } from '@shared/usage/aggregate-usage.ts'
import {
  claudeReasonNeedsLogin,
  createPlanSignInHandler,
  renderModelTable,
  renderPlanProvider,
  renderPlanWorthItSection,
} from './usage-section.ts'

function claudeUnavailable(reason: string): ProviderPlanResult {
  return { status: 'unavailable', provider: 'claude', reason }
}

describe('claudeReasonNeedsLogin', () => {
  it('matches sign-in / credential reasons a re-login would fix', () => {
    assert.equal(
      claudeReasonNeedsLogin('No Claude OAuth token (sign in with `claude auth login`)'),
      true,
    )
    assert.equal(
      claudeReasonNeedsLogin('Claude credentials were rejected. Re-run `claude auth login`.'),
      true,
    )
    assert.equal(
      claudeReasonNeedsLogin('Claude plan usage needs an OAuth token with user:profile scope.'),
      true,
    )
    assert.equal(
      claudeReasonNeedsLogin('No Claude OAuth token (sign in with `claude auth login`)'),
      true,
    )
  })

  it('ignores inherent limitations that a login cannot fix', () => {
    assert.equal(
      claudeReasonNeedsLogin('Console API keys do not expose subscription plan windows'),
      false,
    )
    assert.equal(
      claudeReasonNeedsLogin('Claude usage response had no recognizable plan windows'),
      false,
    )
  })

  it('offers an in-app login for a lapsed access token', () => {
    assert.equal(
      claudeReasonNeedsLogin(
        'Claude’s access token has expired. Usage updates the next time Claude Code refreshes it (any `claude` session or Claude agent turn).',
      ),
      true,
    )
  })
})

describe('renderPlanProvider sign-in button', () => {
  it('shows the button on a rejected Claude card and clicking runs the handler', () => {
    const host = document.createElement('div')
    let clicked = 0
    renderPlanProvider(
      host,
      claudeUnavailable('Claude credentials were rejected. Re-run `claude auth login`.'),
      {
        claude: () => {
          clicked += 1
        },
      },
    )
    const btn = host.querySelector<HTMLButtonElement>('.usage-plan-signin-btn')
    assert.ok(btn, 'expected a sign-in button')
    assert.match(btn.textContent, /Sign in to Claude/)
    // The command renders as inline code, never with its backtick delimiters —
    // in the hint and in the button's plain-text tooltip alike.
    const hint = host.querySelector('.usage-plan-status')
    assert.ok(hint)
    assert.equal(hint.querySelector('code')?.textContent, 'claude auth login')
    assert.doesNotMatch(hint.textContent, /`/)
    assert.doesNotMatch(btn.title, /`/)
    assert.equal(btn.title, 'Open a terminal and run claude auth login')
    btn.click()
    assert.equal(clicked, 1)
  })

  it('omits the button for reasons a login would not fix', () => {
    const host = document.createElement('div')
    renderPlanProvider(
      host,
      claudeUnavailable('Console API keys do not expose subscription plan windows'),
      {
        claude: () => {
          assert.fail('handler should not be wired')
        },
      },
    )
    assert.equal(host.querySelector('.usage-plan-signin-btn'), null)
  })

  it('omits the button when no handler is provided', () => {
    const host = document.createElement('div')
    renderPlanProvider(
      host,
      claudeUnavailable('Claude credentials were rejected. Re-run `claude auth login`.'),
      {},
    )
    assert.equal(host.querySelector('.usage-plan-signin-btn'), null)
  })

  it('shows the Codex button when its credentials were rejected', () => {
    const host = document.createElement('div')
    const codex: ProviderPlanResult = {
      status: 'unavailable',
      provider: 'codex',
      reason: 'Codex credentials were rejected. Run `codex login` again.',
    }
    let clicked = 0
    renderPlanProvider(host, codex, {
      codex: () => {
        clicked += 1
      },
    })
    const btn = host.querySelector<HTMLButtonElement>('.usage-plan-signin-btn')
    assert.ok(btn)
    assert.equal(btn.textContent, 'Sign in to Codex')
    btn.click()
    assert.equal(clicked, 1)
  })
})

describe('renderPlanProvider empty-plan tone', () => {
  it('renders soft unavailable (not red error) when plan windows are absent', () => {
    const host = document.createElement('div')
    renderPlanProvider(host, {
      status: 'unavailable',
      provider: 'claude',
      reason: 'Claude usage response had no recognizable plan windows',
    })
    const status = host.querySelector('.usage-plan-status')
    assert.ok(status)
    assert.equal(status.classList.contains('usage-plan-status-error'), false)
    assert.match(status.textContent, /no recognizable plan windows/i)
  })

  it('keeps the error tone for hard load failures', () => {
    const host = document.createElement('div')
    renderPlanProvider(host, {
      status: 'error',
      provider: 'claude',
      message: 'network down',
    })
    const status = host.querySelector('.usage-plan-status')
    assert.ok(status)
    assert.equal(status.classList.contains('usage-plan-status-error'), true)
    assert.match(status.textContent, /Couldn’t load Claude plan usage/i)
  })
})

describe('renderPlanProvider credit grant', () => {
  it('shows the exact remaining balance and an accessible used-credit bar', () => {
    const host = document.createElement('div')
    renderPlanProvider(host, {
      status: 'ok',
      provider: 'cursor',
      usage: {
        provider: 'cursor',
        plan: 'Ultra',
        creditGrant: {
          remainingCents: 6703,
          totalCents: 10000,
          usedCents: 3297,
        },
        windows: [],
        checkedAt: '2026-07-27T12:00:00.000Z',
      },
    })

    const credit = host.querySelector('.usage-credit-grant')
    assert.ok(credit)
    assert.match(credit.textContent, /\$67\.03 remaining of \$100\.00/)
    const progress = credit.querySelector('[role="progressbar"]')
    assert.ok(progress)
    assert.equal(progress.getAttribute('aria-valuenow'), '33')
    assert.equal(progress.getAttribute('aria-label'), 'Cursor credits $32.97 used of $100.00')
  })
})

describe('renderPlanProvider credit windows', () => {
  it('renders Codex spend_control amounts as credits, not dollars', () => {
    const host = document.createElement('div')
    renderPlanProvider(host, {
      status: 'ok',
      provider: 'codex',
      usage: {
        provider: 'codex',
        plan: 'business',
        windows: [
          {
            id: 'spend_control',
            label: 'Monthly credits',
            usedPercent: 6,
            resetsAt: '2026-09-01T00:00:00.000Z',
            unit: 'credits',
            usedCredits: 972,
            limitCredits: 15000,
          },
        ],
        checkedAt: '2026-08-23T12:00:00.000Z',
      },
    })
    const row = host.querySelector('.usage-plan-window')
    assert.ok(row)
    assert.equal(row.getAttribute('data-unit'), 'credits')
    assert.match(row.textContent, /972 \/ 15000 credits/)
    assert.doesNotMatch(row.textContent, /\$972/)
  })

  it('renders Claude extra_usage credit stats on the window line', () => {
    const host = document.createElement('div')
    renderPlanProvider(host, {
      status: 'ok',
      provider: 'claude',
      usage: {
        provider: 'claude',
        plan: null,
        windows: [
          {
            id: 'extra_usage',
            label: 'Extra usage',
            usedPercent: 10.58,
            resetsAt: null,
            unit: 'credits',
            usedCredits: 10577,
            limitCredits: 100000,
          },
        ],
        checkedAt: '2026-08-23T12:00:00.000Z',
      },
    })
    const stats = host.querySelector('.usage-plan-window-stats')
    assert.ok(stats)
    assert.match(stats.textContent, /10577 \/ 100000 credits/)
    assert.match(stats.textContent, /11% used/)
  })
})

describe('createPlanSignInHandler', () => {
  it('closes settings and requests `claude auth login` in a terminal', () => {
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    const commands: string[] = []
    store.on('request_terminal_command', (cmd) => {
      commands.push(cmd)
    })
    let closed = 0
    const handler = createPlanSignInHandler(store, 'claude', () => {
      closed += 1
    })
    assert.ok(handler)
    handler()
    assert.deepEqual(commands, ['claude auth login'])
    assert.equal(closed, 1)
  })

  it('closes settings and requests `codex login` in a terminal', () => {
    const store = createStore({ filesPaneOpen: false, rightPanelMode: 'explorer' })
    const commands: string[] = []
    store.on('request_terminal_command', (command) => {
      commands.push(command)
    })
    let closed = 0
    const handler = createPlanSignInHandler(store, 'codex', () => {
      closed += 1
    })
    assert.ok(handler)
    handler()
    assert.deepEqual(commands, ['codex login'])
    assert.equal(closed, 1)
  })

  it('returns null without a store to route through', () => {
    assert.equal(createPlanSignInHandler(undefined, 'claude'), null)
  })
})

describe('renderModelTable alignment', () => {
  function row(model: string, over: Partial<ModelUsageBreakdown> = {}): ModelUsageBreakdown {
    return {
      model,
      inputTokens: 1000,
      outputTokens: 200,
      estimatedCostUsd: 0.5,
      isLocal: false,
      pricingKnown: true,
      ...over,
    }
  }

  /** The `<col>` class sequence that defines a table's shared column grid. */
  function colTemplate(table: Element): string[] {
    return [...table.querySelectorAll('colgroup > col')].map((c) => c.className)
  }

  it('gives the Cloud and Local tables an identical column template so they align', () => {
    const host = document.createElement('div')
    // Deliberately different content widths between the two tables — under a
    // shared fixed template the columns must still line up regardless.
    renderModelTable(host, 'Cloud models', [row('scaleway:qwen3-235b-a22b-instruct-2507')], 'none')
    renderModelTable(
      host,
      'Local models (free)',
      [row('lmstudio:q', { isLocal: true, estimatedCostUsd: 0 })],
      'none',
    )
    const [cloud, local] = host.querySelectorAll('table.usage-table')
    assert.ok(cloud && local, 'expected both tables to render')
    const cloudCols = colTemplate(cloud)
    // One model column plus five numeric columns, in the same order for both.
    assert.deepEqual(cloudCols, [
      'usage-col-model',
      'usage-col-num',
      'usage-col-num',
      'usage-col-num',
      'usage-col-num',
      'usage-col-num',
    ])
    assert.deepEqual(colTemplate(local), cloudCols)
    // The column template must have one <col> per header cell, or the widths
    // would map to the wrong columns.
    assert.equal(cloud.querySelectorAll('thead th').length, cloudCols.length)
  })

  it('labels a standard-rate estimate when the used tier has no catalog rate', () => {
    const host = document.createElement('div')
    renderModelTable(
      host,
      'Cloud models',
      [row('gpt-4o', { estimatedCostUsd: 0, tierPricingFallback: true })],
      'none',
    )
    const estimate = host.querySelector('.usage-estimated')
    assert.equal(estimate?.textContent, '(standard rate)')
    assert.match(estimate.getAttribute('title') ?? '', /no published catalog rate/)
  })

  it('uses the friendly ChatGPT plan label and leaves the ledger key and counts intact', () => {
    const host = document.createElement('div')
    const model = 'chatgpt-plan:oaiapp_private-registration#gpt-5.6-luna'
    const usage = row(model, { pricingKnown: false })
    renderModelTable(host, 'Cloud models', [usage], 'none')
    const cells = [...host.querySelectorAll('tbody td')].map((cell) => cell.textContent)
    assert.equal(cells[0], 'GPT-5.6 Luna · ChatGPT plan')
    assert.equal(cells[1], '1.0k')
    assert.equal(cells[2], '200')
    assert.equal(cells[5], 'unpriced')
    assert.equal(host.textContent.includes('oaiapp_'), false)
    assert.equal(usage.model, model)
  })

  it('keeps malformed historical plan selections readable without exposing their registration', () => {
    const host = document.createElement('div')
    assert.doesNotThrow(() => {
      renderModelTable(host, 'Cloud models', [row('chatgpt-plan:old-registration')], 'none')
    })
    assert.equal(host.textContent.includes('old-registration'), false)
  })

  it('distinguishes accounts using their stable saved order and hides registration IDs', () => {
    const host = document.createElement('div')
    const accounts = ['first', 'second'].map((clientId) => ({
      clientId,
      label: 'same@example.com',
      connected: true,
      planEnabled: true,
    }))
    renderModelTable(
      host,
      'Cloud models',
      [row('chatgpt-plan:second#gpt-5.6-luna'), row('chatgpt-plan:first#gpt-5.6-luna')],
      'none',
      accounts,
    )
    const cells = [...host.querySelectorAll('tbody tr td:first-child')].map(
      (cell) => cell.textContent,
    )
    assert.match(cells[0] ?? '', /Connection 2/)
    assert.match(cells[1] ?? '', /Connection 1/)
    assert.equal(host.textContent.includes('chatgpt-plan:'), false)
    const saved = document.createElement('div')
    renderModelTable(
      saved,
      'Cloud models',
      [row('chatgpt-plan:forgotten#gpt-5.6-luna'), row('chatgpt-plan:older#gpt-5.6-luna')],
      'none',
    )
    assert.match(saved.textContent, /Saved connection 1/)
    assert.match(saved.textContent, /Saved connection 2/)
  })

  it('renders a cloud agent run as an unpriced cloud row instead of dropping it (#2448)', () => {
    const host = document.createElement('div')
    // A Cursor / Claude Cloud Agent run records its model as `remote-agent:<provider>`
    // (optionally `#<model>`) — not in the static pricing catalog, so the rate is
    // unknown. The row must still render with its real token counts rather than
    // disappearing from the usage panel.
    renderModelTable(
      host,
      'Cloud models',
      [row('remote-agent:cursor', { pricingKnown: false, estimatedCostUsd: 0 })],
      'No cloud model usage in this period.',
    )
    const table = host.querySelector('table.usage-table')
    assert.ok(table, 'expected the cloud agent run to render a table, not the empty state')
    const cells = [...table.querySelectorAll('tbody tr td')].map((td) => td.textContent)
    assert.equal(cells[0], 'remote-agent:cursor')
    assert.equal(cells[1], '1.0k')
    assert.equal(cells[2], '200')
    assert.equal(cells[5], 'unpriced')
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
