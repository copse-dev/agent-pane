import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

const HOST = '.footer-model-host'

describe('primary prompt model picker', () => {
  before(async () => {
    await browser.url('/?scenario=chat-reading-layout&autoplay=0')
    await $(HOST + ' .model-picker-trigger').waitForDisplayed()
  })

  it('offers prompt matching and preserves Auto on the composer after selection', async () => {
    const picker = $(HOST + ' .model-picker')
    await picker.$('.model-picker-trigger').click()
    await picker.$('.model-picker-browse').click()
    await picker.$('.model-picker-filter').setValue('match prompt')
    const option = picker.$('.model-picker-option[data-value="auto:match-prompt"]')
    await option.waitForDisplayed()
    await expect(option).toHaveText(expect.stringContaining('Auto — match prompt'))
    await saveElementScreenshot(HOST + ' .model-picker-menu', 'prompt-model-picker.png')
    await option.click()
    await expect(picker.$('.model-picker-trigger')).toHaveText(expect.stringContaining('Auto —'))
    await saveElementScreenshot(HOST, 'prompt-model-selected.png')
    await picker.$('.model-picker-trigger').click()
    await expect(picker.$('.model-picker-option[data-value="auto:match-prompt"]')).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })
})
