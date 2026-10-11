import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

// Bug-hunt #20 and #41: keyboard and form input that used to be taken for
// something else. The two-step stop must not stay armed once the user types
// anything else, and an emptied font size must not be saved as NaN.
describe('renderer input guards', () => {
  it('disarms the Escape-armed stop when another key follows', async () => {
    await browser.url('/?scenario=sidebar-thread-changes')
    await $('.chat-row[data-thread-id="demo-sidebar-changes-running"]').click()
    const stop = $('.stop-btn')
    await stop.waitForDisplayed()
    // Nothing focused — no editor, not the composer — as when reading.
    await browser.execute(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })

    await browser.keys('Escape')
    await expect(stop).toHaveElementClass('stop-pending')
    await saveElementScreenshot('#input-bar', 'renderer-input-guards-stop-armed.png')

    await browser.keys(':')
    await expect(stop).not.toHaveElementClass('stop-pending')
    await browser.keys('Enter')
    // Still running: the Enter after `:` was not a stop.
    await expect(stop).toBeDisplayed()
    await saveElementScreenshot('#input-bar', 'renderer-input-guards-stop-disarmed.png')
  })

  it('keeps the current font size when the field is emptied and saved', async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="appearance"]').click()
    const fontSize = $('#settings-dialog input[name="fontSize"]')
    await fontSize.waitForDisplayed()
    await expect(fontSize).toHaveValue('14')

    await fontSize.clearValue()
    await expect(fontSize).toHaveValue('')
    await saveElementScreenshot('#settings-dialog', 'renderer-input-guards-font-size-empty.png')
    await $('#settings-dialog button[type="submit"]').click()
    await $('#settings-dialog').waitForDisplayed({ reverse: true })
    await expect($('.toast-error')).not.toBeExisting()

    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="appearance"]').click()
    await expect($('#settings-dialog input[name="fontSize"]')).toHaveValue('14')
  })
})
