import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('web search provider settings', () => {
  it('selects Tavily through Settings, saves the preference and restores it on reopen', async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="web-search"]').click()
    const select = $('[name="webSearchProvider"]')
    await expect(select).toHaveValue('none')
    await select.selectByAttribute('value', 'tavily')
    await expect($('[name="tavilyKey"]')).toBeDisplayed()
    await expect($('[name="parallelKey"]')).not.toBeDisplayed()
    await expect($('.settings-section[data-section="web-search"]')).toHaveText(
      expect.stringContaining('Generated answers are disabled'),
    )
    await saveElementScreenshot('#settings-dialog', 'settings-web-search-tavily.png')
    await $('#settings-dialog button[type="submit"]').click()
    await $('#settings-dialog').waitForDisplayed({ reverse: true })
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="web-search"]').click()
    await expect(select).toHaveValue('tavily')
    await select.selectByAttribute('value', 'parallel')
    await expect($('[name="parallelKey"]')).toBeDisplayed()
    await expect($('[name="tavilyKey"]')).not.toBeDisplayed()
    await $('#settings-cancel').click()
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="web-search"]').click()
    await expect(select).toHaveValue('tavily')
  })
})
