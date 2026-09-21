import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

describe('global OpenAI service tier', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-openai-service-tier')
    seedE2eViewport({ width: 1280, height: 800 }, { openAiServiceTier: 'flex' })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('explains, saves, and restores the first-party OpenAI default', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const providers = $('#settings-providers-host fieldset')
    await expect(providers).toBeDisplayed()
    await providers.$('.provider-chip[data-provider="openai"]').click()

    const picker = providers.$('select[name="openAiServiceTier"]')
    await expect(picker).toBeDisplayed()
    await expect(picker).toHaveValue('flex')
    await expect(picker.$$('option')).toBeElementsArrayOfSize(4)
    await expect(picker.$$('option')[0]).toHaveText('Project default')
    await expect(picker.$$('option')[1]).toHaveText('Standard')
    await expect(picker.$$('option')[2]).toHaveText('Flex')
    await expect(picker.$$('option')[3]).toHaveText('Fast')
    await expect(providers.$('.openai-service-tier-scope')).toHaveText(
      'Applies to every first-party OpenAI model request',
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
    await $('[aria-label="Settings"]').click()
    await $('#settings-providers-host .provider-chip[data-provider="openai"]').click()
    await expect($('#settings-providers-host select[name="openAiServiceTier"]')).toHaveValue('fast')
  })
})
