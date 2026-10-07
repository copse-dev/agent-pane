import { $, $$, browser, expect } from '@wdio/globals'
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

  it('pins the first choice in the picker without a routing message in the conversation', async () => {
    await browser.url('/?scenario=prompt-model-first-ask&autoplay=0')
    const label = $(HOST + ' .model-picker-label')
    await expect(label).toHaveText('Auto — match prompt')
    await $('.prompt-input').setValue('Check for typos in the README')
    await $('.submit-btn').click()
    await expect(label).toHaveText('Claude Haiku 4.5')
    await expect(label).toHaveAttribute('title', 'claude-haiku-4-5')
    await expect($('.messages-list .msg-assistant')).toHaveText(
      expect.stringContaining('I’ll check the README for typos.'),
    )
    await expect($$('.messages-list .msg-assistant')).toBeElementsArrayOfSize(1)
    await expect($('.messages-list')).not.toHaveText(
      expect.stringContaining('Auto — match prompt:'),
    )
    await expect($('.messages-list')).not.toHaveText(expect.stringContaining('Prompt assessment'))
    await saveElementScreenshot('#app', 'prompt-model-first-ask.png')
    await $('.prompt-input').setValue('Now investigate a complex concurrency bug')
    await $('.submit-btn').click()
    await expect($$('.messages-list .msg-assistant')).toBeElementsArrayOfSize(2)
    await expect(label).toHaveText('Claude Haiku 4.5')
  })
})
