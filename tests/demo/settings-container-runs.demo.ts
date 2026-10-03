import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

/**
 * The Experimental setting for unattended container runs names every origin
 * a run can reach: the model's, and the install hosts an installing run (the
 * dialog's default) admits. It must not claim the model's origin alone.
 */
describe('browser-hosted container-run setting copy', () => {
  before(async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').$('button[data-section="experimental"]').click()
    await $('.settings-section[data-section="experimental"]').waitForDisplayed()
  })

  it('lists the dependency-install hosts beside the model origin', async () => {
    const fieldset = $('#settings-dialog fieldset:has(input[name="containerRunsEnabled"])')
    await fieldset.scrollIntoView({ block: 'center' })
    await expect(fieldset).toBeDisplayed()
    const hint = fieldset.$('.field-hint')
    await expect(hint).toHaveText(expect.stringContaining("reaches only its model's origin"))
    await expect(hint).toHaveText(
      expect.stringContaining("the npm registry, GitHub and Electron's download hosts"),
    )
    await expect(hint).toHaveText(expect.stringContaining('on by default, per run'))
    await expect(hint).not.toHaveText(expect.stringContaining("reaching only its model's origin"))

    await saveElementScreenshot(
      '#settings-dialog fieldset:has(input[name="containerRunsEnabled"])',
      'settings-container-runs-egress-copy.png',
    )
  })
})
