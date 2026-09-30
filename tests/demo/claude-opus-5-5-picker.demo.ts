import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

/**
 * Claude Opus 5.5 in the footer model picker over the mocked backend. The
 * `concise-thread` scenario runs on Opus 5.5, so the demo API reports an
 * Anthropic key and the Cloud models group lists every tracked Claude id.
 * Opus 5.5 rejects `thinking: { type: 'disabled' }`, so its effort menu must
 * not offer "No thinking" the way Opus 5's does.
 */
describe('Claude Opus 5.5 in the model picker (browser-hosted)', () => {
  it('lists Opus 5.5 with its intellect and an effort ladder without "No thinking"', async () => {
    await browser.url('/?scenario=concise-thread')
    const picker = await $('.footer-model-host .model-picker')
    await picker.waitForExist()

    await picker.$('.model-picker-trigger').click()
    await picker.$('.model-picker-browse').click()
    await picker.$('.model-picker-filter').setValue('Opus 5')
    const opus = picker.$('.model-picker-option[data-value="claude-opus-5-5"]')
    await expect(opus).toBeDisplayed()
    await expect(opus).toHaveText(/^Claude Opus 5\.5 — intellect ~\d+(\.\d)? · \$[\d.]+\/MTok/)
    await saveElementScreenshot(
      '.footer-model-host .model-picker-menu',
      'claude-opus-5-5-picker.png',
    )
    await opus.click()
    await expect(picker.$('.model-picker-trigger')).toHaveText(/Claude Opus 5\.5/)

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
    await saveElementScreenshot(
      '.footer-model-host .model-picker-menu',
      'claude-opus-5-5-effort.png',
    )
    await browser.keys('Escape')
  })
})
