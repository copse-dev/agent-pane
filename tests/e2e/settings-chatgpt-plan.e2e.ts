import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

describe('native ChatGPT plan connection settings', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-chatgpt-plan', {
      usageEvents: [
        {
          at: Date.now(),
          model: 'chatgpt-plan:oaiapp_fixture#gpt-5.6-luna',
          source: 'agent',
          inputTokens: 447300,
          outputTokens: 1300,
          cacheReadTokens: 121900,
          threadId: 'fixture-thread',
          projectId: 'e2e-chatgpt-plan',
        },
      ],
    })
    seedE2eViewport({ width: 1280, height: 800 })
    await browser.reloadSession()
  })
  after(() => {
    resetUserData()
  })

  it('offers browser sign-in alongside OpenAI API keys and explains the billing path', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-providers-host .provider-chip[data-provider="openai"]').click()
    const section = $('[data-testid="chatgpt-plan-section"]')
    await $('#settings-providers-host').scrollIntoView()
    await expect(section).toBeDisplayed()
    await expect(section.parentElement()).toHaveText('Copse’s agent and tools', {
      containing: true,
    })
    await expect(section.parentElement()).toHaveText('plan or available credits', {
      containing: true,
    })
    await expect(section.$('[data-testid="chatgpt-plan-connect"]')).toHaveText(
      'Continue with ChatGPT',
    )
    await expect(section.$('[data-testid="chatgpt-plan-connect"]')).toBeEnabled()
    await expect(section.$('select')).not.toExist()
    await expect(section).toHaveText('Manage usage', { containing: true })
    const apiDetails = $('[data-testid="openai-api-details"]')
    const codexDetails = $('[data-testid="openai-codex-details"]')
    await expect(apiDetails).not.toHaveAttribute('open')
    await expect(codexDetails).not.toHaveAttribute('open')
    await expect(apiDetails.$('input')).not.toBeDisplayed()
    await saveAppScreenshot('settings-chatgpt-plan.png')
    await apiDetails.$('summary').click()
    await expect(apiDetails.$('input')).toBeDisplayed()
    await expect(apiDetails.$('[data-testid="openai-service-tier-block"]')).toBeDisplayed()
    await apiDetails.$('summary').click()
    await codexDetails.$('summary').click()
    await expect(codexDetails.$('input[placeholder="gemini"]')).toExist()
    await saveAppScreenshot('settings-openai-codex-expanded.png')
  })
  it('shows a readable plan model label in Usage without its client ID', async () => {
    await $('.settings-nav-btn[data-section="usage"]').click()
    const row = $('.usage-model-group tbody tr')
    await row.waitForExist()
    await expect(row.$('td')).toHaveText(/GPT-5\.6[- ]Luna · ChatGPT plan/)
    await expect(row).not.toHaveText('oaiapp_', { containing: true })
    await browser.execute(() => {
      document.querySelector('.usage-model-group')?.scrollIntoView({ block: 'center' })
    })
    await saveElementScreenshot('.usage-model-group', 'settings-chatgpt-plan-usage.png')
  })
})
