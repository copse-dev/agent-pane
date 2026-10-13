import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

/**
 * GPT-6.1 Sol in the footer model picker over the mocked backend. The
 * `concise-thread-full` scenario runs on `gpt-4o`, so the demo API reports an
 * OpenAI key and the Cloud models group lists every tracked OpenAI id. GPT-6.1
 * Sol has no account gate (unlike Astra), so a working key is all it needs.
 */
describe('GPT-6.1 Sol in the model picker (browser-hosted)', () => {
  it('lists GPT-6.1 Sol with its intellect and offers its low-through-max effort ladder', async () => {
    await browser.url('/?scenario=concise-thread-full')
    const picker = await $('.footer-model-host .model-picker')
    await picker.waitForExist()

    await picker.$('.model-picker-trigger').click()
    await picker.$('.model-picker-browse').click()
    await picker.$('.model-picker-filter').setValue('GPT-6')
    const sol = picker.$('.model-picker-option[data-value="gpt-6.1-sol"]')
    await expect(sol).toBeDisplayed()
    await expect(sol).toHaveText(/^GPT-6\.1 Sol: intellect ~\d+(\.\d)? · \$[\d.]+\/MTok/)
    await saveElementScreenshot('.footer-model-host .model-picker-menu', 'gpt-6-1-sol-picker.png')

    await sol.click()
    await expect(picker.$('.model-picker-trigger')).toHaveText(/GPT-6\.1 Sol/)

    // OpenAI documents low, medium, high, xhigh and max — no none/minimal.
    await picker.$('.model-picker-trigger').click()
    const row = picker.$('.model-picker-group-row')
    await row.waitForDisplayed()
    await expect(row.$('.model-picker-group-row-label')).toHaveText('Effort')
    await row.click()
    const labels = await browser.execute(() =>
      [
        ...document.querySelectorAll('.footer-model-host .model-picker-menu .model-picker-option'),
      ].map((option) => (option.textContent ?? '').trim()),
    )
    expect(labels).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max'])
    await saveElementScreenshot('.footer-model-host .model-picker-menu', 'gpt-6-1-sol-effort.png')
    await browser.keys('Escape')
  })
})
