import { $, browser, expect } from '@wdio/globals'
import { delimiter, join } from 'node:path'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import {
  pinTextForCapture,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

describe('native ChatGPT plan connection settings', () => {
  const originalPath = process.env['PATH']
  const originalPreservePath = process.env['COPSE_PRESERVE_PATH']
  before(async () => {
    resetUserData()
    // Isolate adapter detection from ambient host CLIs, as in the API-tier spec.
    writeE2eEnv({
      COPSE_PRESERVE_PATH: '1',
      PATH: (process.platform === 'win32'
        ? [join(process.env['SystemRoot'] ?? 'C:\Windows', 'System32')]
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

  it('offers browser sign-in from the ChatGPT row and explains the billing path', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    const row = $('[data-testid="models-agents-list"] [data-row="plan:chatgpt"]')
    await row.waitForExist({ timeout: 15_000 })
    await expect(row.$('.acp-row-name strong')).toHaveText('ChatGPT')
    await expect(row.$('.acp-row-desc')).toHaveText('plan or available credits', {
      containing: true,
    })
    // Not signed in: no Ready chip, and the row's action is Sign in.
    await expect(row.$('.acp-row-chip')).not.toExist()
    // The ChatGPT plan, Codex and an OpenAI key are separate connections, so the
    // plan row never carries Codex or API-key controls.
    await expect(row.$('[name="openAiServiceTier"]')).not.toExist()
    await row.$('button=Sign in').click()
    const section = row.$('[data-testid="chatgpt-plan-section"]')
    await expect(section).toBeDisplayed()
    await expect(section.$('[data-testid="chatgpt-plan-connect"]')).toHaveText(
      'Continue with ChatGPT',
    )
    await expect(section.$('[data-testid="chatgpt-plan-connect"]')).toBeEnabled()
    await expect(section.$('select')).not.toExist()
    await expect(section).toHaveText('Manage usage', { containing: true })
    await row.scrollIntoView({ block: 'center' })
    await saveAppScreenshot('settings-chatgpt-plan.png')
    await row.$('button=Hide options').click()
  })
  it('shows a readable plan model label in Usage without its client ID', async () => {
    await $('.settings-nav-btn[data-section="usage"]').click()
    // Ledger events expire after 90 days; All time reads saved threads instead.
    await $('.usage-period-btn[data-period="month"]').click()
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
    // The retention window requires a live event date. Assert the real ledger
    // note, then pin only its wall-clock text for this capture.
    await expect($('#usage-period-body')).toHaveText(/Ledger: 2 event\(s\) tracked \(since /)
    const restoreDate = await pinTextForCapture(
      '#usage-period-body',
      /tracked \(since [^)]+\)/,
      'tracked (since 1/15/2026, 12:00:00 PM)',
    )
    try {
      await saveElementScreenshot('#usage-period-body', 'settings-chatgpt-plan-usage.png')
    } finally {
      await restoreDate()
    }
  })
})
