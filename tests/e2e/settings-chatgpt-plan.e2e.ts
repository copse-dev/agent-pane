import { $, browser, expect } from '@wdio/globals'
import { delimiter, join } from 'node:path'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

async function rejectFreshAcpBootstrap(): Promise<void> {
  // This settings/usage spec does not authorize a real adapter installation.
  // Exercise and reject its genuine fresh-install consent before continuing.
  const dialog = $('#approval-dialog')
  await dialog.waitForDisplayed({ timeout: 10_000 })
  await expect(dialog.$('.approval-heading')).toHaveText(
    'Install software to connect your coding agents?',
  )
  await expect(dialog.$('.approval-body')).toHaveText('@agentclientprotocol/codex-acp', {
    containing: true,
  })
  await expect(dialog.$('.approval-body')).toHaveText('Socket Firewall', { containing: true })
  await dialog.$('.approval-reject').click()
  await expect(dialog).not.toBeDisplayed()
  await expect($('#settings-dialog')).toBeDisplayed()
}

describe('native ChatGPT plan connection settings', () => {
  const originalPath = process.env['PATH']
  const originalPreservePath = process.env['COPSE_PRESERVE_PATH']
  before(async () => {
    resetUserData()
    // Isolate adapter detection from ambient host CLIs, as in the API-tier spec.
    writeE2eEnv({
      COPSE_PRESERVE_PATH: '1',
      PATH: (process.platform === 'win32'
        ? [join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')]
        : ['/usr/bin', '/bin']
      ).join(delimiter),
    })
    seedEmptyProject(process.cwd(), 'e2e-chatgpt-plan', {
      registeredAcpAgents: [
        { id: 'codex-acp', title: 'Codex', command: 'codex-acp', enabled: true },
      ],
      usageEvents: [
        {
          at: Date.now(),
          model: 'chatgpt-plan:oaiapp_second#gpt-5.6-luna',
          source: 'agent',
          inputTokens: 1000,
          outputTokens: 200,
          threadId: 'fixture-second-thread',
          projectId: 'e2e-chatgpt-plan',
        },
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
    writeE2eEnv({ COPSE_PRESERVE_PATH: originalPreservePath, PATH: originalPath })
    resetUserData()
  })

  it('offers browser sign-in alongside OpenAI API keys and explains the billing path', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-providers-host .provider-chip[data-provider="openai"]').click()
    await rejectFreshAcpBootstrap()
    await expect($('.openai-connection-card[data-connection="chatgpt"] h4')).toHaveText(
      'ChatGPT plan',
    )
    await expect($('.openai-connection-card[data-connection="api"] h4')).toHaveText('OpenAI API')
    await expect($('.openai-connection-card[data-connection="codex"] h4')).toHaveText('Codex agent')
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
    await expect(codexDetails.$('.acp-known-status')).toHaveText('not installed')
    await expect(codexDetails).toHaveText('Re-scan device', { containing: true })
    await saveAppScreenshot('settings-openai-codex-expanded.png')
  })
  it('shows a readable plan model label in Usage without its client ID', async () => {
    await $('.settings-nav-btn[data-section="usage"]').click()
    const row = $('.usage-model-group tbody tr')
    await row.waitForExist()
    await expect(row.$('td')).toHaveText(/GPT-5\.6[- ]Luna · ChatGPT plan/)
    await expect(row).not.toHaveText('oaiapp_', { containing: true })
    await expect($('.usage-model-group')).toHaveText('Saved connection 1', { containing: true })
    await expect($('.usage-model-group')).toHaveText('Saved connection 2', { containing: true })
    await expect($('#usage-period-body button')).toHaveText('Manage ChatGPT usage')
    await browser.execute(() => {
      document.querySelector('.usage-model-group')?.scrollIntoView({ block: 'center' })
    })
    await saveElementScreenshot('#usage-period-body', 'settings-chatgpt-plan-usage.png')
  })
})
