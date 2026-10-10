import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

describe('Qwen Code setup guidance', () => {
  const originalPath = process.env['PATH']
  const originalPreservePath = process.env['COPSE_PRESERVE_PATH']

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    // Reach the real not-installed state without depending on host CLIs.
    writeE2eEnv({
      COPSE_PRESERVE_PATH: '1',
      PATH:
        process.platform === 'win32'
          ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')
          : '/usr/bin:/bin',
    })
    seedEmptyProject(process.cwd(), 'e2e-settings-qwen-code')
    await browser.reloadSession()
  })

  after(() => {
    writeE2eEnv({ COPSE_PRESERVE_PATH: originalPreservePath, PATH: originalPath })
    resetUserData()
  })

  it('shows the install command, provider setup command, and current auth requirements', async function () {
    this.timeout(60_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    const chip = $('.provider-chip[data-provider="qwen-code"]')
    await chip.waitForExist({ timeout: 15_000 })
    await chip.click()
    const form = $('.provider-form')
    // Opening a provider can offer to install missing curated adapters. Keep
    // that separate real approval flow closed for this guidance-only eval.
    const approval = $('#approval-dialog')
    const offeredInstall = await approval.waitForDisplayed({ timeout: 5000 }).then(
      () => true,
      () => false,
    )
    if (offeredInstall) {
      await expect(approval.$('.approval-heading')).toHaveText('Install ACP adapters globally?')
      await approval.$('.approval-reject').click()
      await expect(approval).not.toBeDisplayed()
    }
    await expect(form.$('.provider-form-title')).toHaveText(expect.stringContaining('Qwen Code'))
    const rows = await form.$$('.acp-cmd-row').getElements()
    assert.deepEqual(await rows.map((row) => row.$('.acp-cmd-label').getText()), [
      'Install',
      'Sign in',
    ])
    assert.deepEqual(await rows.map((row) => row.$('code').getText()), [
      'npm install -g @qwen-code/qwen-code',
      'qwen',
    ])
    await expect(form.$('.acp-known-agent-note')).toHaveText(
      expect.stringContaining('Qwen OAuth’s free tier has ended'),
    )
    assert.deepEqual(await form.$$('.acp-known-agent-note code').map((code) => code.getText()), [
      'qwen',
      '/auth',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_MODEL',
    ])
    await expect(form.$('a')).toHaveAttribute(
      'href',
      'https://github.com/copse-dev/agent-pane/blob/main/docs/acp-qwen-findings.md#hosted-endpoint-configuration',
    )
    await form.scrollIntoView({ block: 'center' })
    await saveElementScreenshot('#settings-dialog', 'settings-qwen-code.png')
  })
})
