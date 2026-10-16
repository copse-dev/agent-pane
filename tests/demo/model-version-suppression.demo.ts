import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

/**
 * Older cloud releases in the footer model picker over the mocked backend. The
 * `container-run` scenario runs its thread on Claude Sonnet 4.6, so the demo API
 * reports an Anthropic key and the Cloud models group offers every tracked
 * Claude id. Sonnet 5.5 supersedes both older Sonnets: Sonnet 5 drops out of
 * the list, while the saved Sonnet 4.6 selection stays, disabled, naming the
 * release that replaces it — in the trigger and in the browse list.
 */
describe('superseded model versions in the model picker (browser-hosted)', () => {
  it('keeps only the newest Sonnet selectable and explains the saved older one', async () => {
    await browser.url('/?scenario=container-run')
    const picker = await $('.footer-model-host .model-picker')
    await picker.waitForExist()

    const trigger = picker.$('.model-picker-trigger')
    await expect(trigger).toHaveText(
      /^Claude Sonnet 4\.6: intellect [\d.]+ · \$[\d.]+\/MTok \(superseded by Claude Sonnet 5\.5\)/,
    )

    await trigger.click()
    await picker.$('.model-picker-browse').click()
    await picker.$('.model-picker-filter').setValue('Sonnet')
    const newest = picker.$('.model-picker-option[data-value="claude-sonnet-5-5"]')
    await expect(newest).toBeDisplayed()
    await expect(newest).toBeEnabled()
    await expect(newest).toHaveText(/^Claude Sonnet 5\.5: intellect ~?[\d.]+ · \$[\d.]+\/MTok/)
    const saved = picker.$('.model-picker-option[data-value="claude-sonnet-4-6"]')
    await expect(saved).toBeDisplayed()
    await expect(saved).toBeDisabled()
    await expect(saved).toHaveText(/\(superseded by Claude Sonnet 5\.5\)/)
    await expect(picker.$('.model-picker-option[data-value="claude-sonnet-5"]')).not.toExist()
    await saveElementScreenshot(
      '.footer-model-host .model-picker-menu',
      'model-version-suppression-picker.png',
    )
    await browser.keys('Escape')
  })
})
