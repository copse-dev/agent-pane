import assert from 'node:assert/strict'
import { $, $$, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

// Plan usage reads a provider's sign-in only once that provider is set up in
// Settings → General. `confirmed-only` keeps the network mocked but applies
// the real confirmation to the seeded settings: one enabled Codex agent.
describe('settings usage panel plans that are not set up', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-usage-unconfirmed-plans', {
      registeredAcpAgents: [
        { id: 'codex-acp', title: 'Codex', command: 'codex-acp', enabled: true },
      ],
    })
    writeE2eEnv({ COPSE_PLAN_USAGE_MOCK: 'confirmed-only' })
    await browser.reloadSession()
  })

  after(async () => {
    writeE2eEnv({})
    resetUserData()
    await browser.reloadSession()
  })

  it('shows usage for the confirmed plan and points the rest at Settings → General', async () => {
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()

    await expect($('.usage-plan-provider[data-provider="codex"][data-status="ok"]')).toBeDisplayed()

    const expected: Record<string, RegExp> = {
      claude: /^Set up Claude Code in Settings → General/,
      huggingface: /^Save a Hugging Face key in Settings → General/,
      cursor: /^Set up Cursor in Settings → General/,
    }
    for (const [provider, reason] of Object.entries(expected)) {
      const card = $(`.usage-plan-provider[data-provider="${provider}"][data-status="unavailable"]`)
      await expect(card).toBeDisplayed()
      assert.match(await card.$('.usage-plan-status').getText(), reason)
    }
    // Not a credential failure, so no sign-in recovery is offered.
    assert.equal((await $$('.usage-plan-signin-btn')).length, 0)

    await prepareE2eScreenshot()
    await saveElementScreenshot('#settings-dialog', 'settings-usage-plan-unconfirmed.png')
  })
})
