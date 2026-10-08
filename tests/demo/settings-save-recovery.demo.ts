import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('Settings appearance after a partial save', () => {
  it('cancels later previews back to the appearance already saved', async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    // Inject failure at the existing API boundary, without a product-only test flag.
    await browser.execute(() => {
      window.api.settings.setSecurity = async () => {
        throw new Error('Security save failed')
      }
    })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="appearance"]').click()
    const theme = $('[name="theme"]')
    await theme.selectByAttribute('value', 'light')
    await $('#settings-dialog button[data-section="permissions"]').click()
    const safety = $('[name="autoRunSandboxCommands"]')
    await safety.scrollIntoView()
    await safety.click()
    await $('#settings-dialog button[type="submit"]').click()
    await expect($('#settings-save-status')).toHaveText(
      expect.stringContaining('Security save failed'),
    )
    await expect($('#settings-dialog')).toBeDisplayed()
    assert.equal(await browser.execute(() => document.documentElement.dataset['theme']), 'light')
    const statusLayer = await browser.execute(() => {
      const status = document.querySelector('#settings-save-status')!
      const style = getComputedStyle(status)
      return { position: style.position, zIndex: Number(style.zIndex) }
    })
    assert.equal(statusLayer.position, 'relative')
    assert.ok(statusLayer.zIndex > 0, 'failure text must sit above the frosted footer')
    await saveElementScreenshot('#settings-dialog', 'settings-partial-save-error.png')
    await $('#settings-dialog button[data-section="appearance"]').click()
    await theme.selectByAttribute('value', 'dark')
    assert.equal(await browser.execute(() => document.documentElement.dataset['theme']), 'dark')
    await $('#settings-cancel').click()
    await expect($('#settings-dialog')).not.toBeDisplayed()
    // The native dialog close event delivers rollback asynchronously.
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.documentElement.dataset['theme'])) === 'light',
      { timeoutMsg: 'Cancel must restore the successfully saved light theme' },
    )
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="appearance"]').click()
    await expect(theme).toHaveValue('light')
    await saveElementScreenshot('#settings-dialog', 'settings-partial-save-restored.png')
  })

  it('restores visible Settings content when recovery arrives during a search', async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    await $('[aria-label="Settings"]').click()
    const search = $('#settings-search-input')
    await search.setValue('nothing-matches-this-setting')
    await expect($('#settings-search-empty')).toBeDisplayed()
    // Exercise the dialog's existing recovery event boundary. The component
    // test separately verifies openModelSettings supplies and focuses its target.
    await browser.execute(() => {
      document.querySelector('#settings-dialog')!.dispatchEvent(new Event('settings-reveal-model'))
    })
    await expect(search).toHaveValue('')
    await expect($('.settings-section[data-section="general"]')).toBeDisplayed()
    await expect($('#settings-search-empty')).not.toBeDisplayed()
    await saveElementScreenshot('#settings-dialog', 'settings-search-recovery.png')
  })
})
