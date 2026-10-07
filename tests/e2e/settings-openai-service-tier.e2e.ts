import { $, browser, expect } from '@wdio/globals'
import { delimiter, join } from 'node:path'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

async function rejectFreshAcpBootstrap(): Promise<void> {
  // Selecting OpenAI also offers its device-agent capability. This spec tests
  // first-party API settings, so decline any real adapter/bootstrap request
  // through its consent UI rather than letting ambient CLIs change the run.
  const dialog = $('#approval-dialog')
  await dialog.waitForDisplayed({ timeout: 10_000 })
  await expect(dialog.$('.approval-heading')).toHaveText('Install coding-agent adapters globally?')
  await expect(dialog.$('.approval-body')).toHaveText('@agentclientprotocol/codex-acp', {
    containing: true,
  })
  await expect(dialog.$('.approval-body')).toHaveText('Socket Firewall', { containing: true })
  await dialog.$('.approval-reject').click()
  await expect(dialog).not.toBeDisplayed()
  await expect($('#settings-dialog')).toBeDisplayed()
}

describe('global OpenAI service tier', () => {
  const originalPath = process.env['PATH']
  const originalPreservePath = process.env['COPSE_PRESERVE_PATH']
  before(async () => {
    resetUserData()
    // Keep host adapters out of detection so every platform exercises the
    // same genuine fresh-install consent path, without mutating the machine.
    writeE2eEnv({
      COPSE_PRESERVE_PATH: '1',
      PATH: (process.platform === 'win32'
        ? [join(process.env['SystemRoot'] ?? 'C:\Windows', 'System32')]
        : ['/usr/bin', '/bin']
      ).join(delimiter),
    })
    seedEmptyProject(process.cwd(), 'e2e-openai-service-tier')
    seedE2eViewport({ width: 1280, height: 800 }, { openAiServiceTier: 'flex' })
    await browser.reloadSession()
  })

  after(() => {
    writeE2eEnv({ COPSE_PRESERVE_PATH: originalPreservePath, PATH: originalPath })
    resetUserData()
  })

  it('explains, saves, and restores the first-party OpenAI default', async function () {
    this.timeout(60_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const providers = $('#settings-providers-host fieldset')
    await expect(providers).toBeDisplayed()
    await providers.$('.provider-chip[data-provider="openai"]').click()
    await rejectFreshAcpBootstrap()

    await providers.$('[data-testid="openai-api-details"] summary').click()
    const picker = providers.$('select[name="openAiServiceTier"]')
    await expect(picker).toBeDisplayed()
    await expect(picker).toHaveValue('flex')
    await expect(picker.$$('option')).toBeElementsArrayOfSize(4)
    await expect(picker.$$('option')[0]).toHaveText('Project default')
    await expect(picker.$$('option')[1]).toHaveText('Standard')
    await expect(picker.$$('option')[2]).toHaveText('Flex')
    await expect(picker.$$('option')[3]).toHaveText('Fast')
    await expect(providers.$('.openai-service-tier-scope')).toHaveText(
      'Applies to OpenAI API-key requests',
      { containing: true },
    )

    await picker.selectByAttribute('value', 'fast')
    await expect(providers.$('copse-ui-field[label="Global OpenAI service tier"]')).toHaveText(
      'higher per-token price',
      { containing: true },
    )
    await saveElementScreenshot(
      '[data-testid="openai-service-tier-block"]',
      'settings-openai-service-tier.png',
    )

    await $('.settings-buttons button[type="submit"]').click()
    await $('#settings-dialog').waitForDisplayed({ reverse: true, timeout: 30_000 })
    // A fresh renderer also verifies persistence and repeats the real consent path.
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-providers-host .provider-chip[data-provider="openai"]').click()
    await rejectFreshAcpBootstrap()
    await expect($('#settings-providers-host select[name="openAiServiceTier"]')).toHaveValue('fast')
  })
})
