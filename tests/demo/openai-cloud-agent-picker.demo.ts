import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('OpenAI cloud agent prototype picker', () => {
  it('shows API billing and retention before selecting the hosted agent', async () => {
    await browser.url('/?scenario=concise-thread-full')
    const picker = await $('.footer-model-host .model-picker')
    await picker.waitForExist()
    await picker.$('.model-picker-trigger').click()
    await picker.$('.model-picker-browse').click()
    await picker.$('.model-picker-filter').setValue('OpenAI Cloud Agent')
    const option = picker.$('.model-picker-option[data-value="remote-agent:openai#gpt-6.1-sol"]')
    await expect(option).toBeDisplayed()
    await expect(picker.$('.model-picker-menu')).toHaveText(/prototype.*API billed.*no ZDR/i)
    await saveElementScreenshot(
      '.footer-model-host .model-picker-menu',
      'openai-cloud-agent-picker.png',
    )
    await option.click()
    await expect(picker.$('.model-picker-trigger')).toHaveText(/GPT-6.1 Sol/)
  })
})
