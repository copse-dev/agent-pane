import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('native dialog text selection', () => {
  it('keeps Activity approval chrome non-selectable without disabling the action', async () => {
    await browser.url('/?scenario=approval-light-accent')
    await $('#approval-dialog').waitForDisplayed()
    await $('.projects-activity-btn').click()
    await $('#activity-panel').waitForDisplayed()
    const approve = $('#activity-panel .activity-approve')
    await approve.waitForEnabled()
    await expect(approve).toHaveText('Approve')

    const drag = await browser.execute(() => {
      const button = document.querySelector('#activity-panel .activity-approve')
      if (!button) return null
      window.getSelection()?.removeAllRanges()
      const range = document.createRange()
      range.selectNodeContents(button)
      const text = range.getBoundingClientRect()
      const bounds = button.getBoundingClientRect()
      return {
        startX: Math.ceil(text.left + 1),
        endX: Math.ceil(bounds.right + 8),
        y: Math.round(text.top + text.height / 2),
      }
    })
    assert.ok(drag)
    // Release outside the button so this selection gesture cannot approve.
    await browser
      .action('pointer')
      .move({ x: drag.startX, y: drag.y })
      .down({ button: 0 })
      .move({ x: drag.endX, y: drag.y, duration: 300 })
      .up({ button: 0 })
      .perform()
    assert.equal(await browser.execute(() => window.getSelection()?.toString()), '')
    assert.equal((await approve.getCSSProperty('user-select')).value, 'none')
    await expect(approve).toBeDisplayed()
    await saveElementScreenshot('#activity-panel', 'activity-dialog-text-selection.png')

    // Tab navigation still reaches the action, and a real click answers it.
    await $('#activity-panel .activity-row-open').click()
    await browser.keys('Tab')
    await expect($('#activity-panel .activity-reject')).toBeFocused()
    await browser.keys('Tab')
    await expect(approve).toBeFocused()
    await approve.click()
    await $('#activity-panel .activity-approve').waitForExist({ reverse: true })
  })

  it('preserves text selection in an opted-in modal input', async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    await $('[aria-label="Settings"]').click()
    const input = $('#settings-search-input')
    await input.waitForDisplayed()
    await input.setValue('terminal')
    await input.doubleClick()
    const selection = await browser.execute(() => {
      const field = document.querySelector<HTMLInputElement>('#settings-search-input')
      if (!field) return null
      return {
        userSelect: getComputedStyle(field).userSelect,
        text: field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0),
      }
    })
    assert.deepEqual(selection, { userSelect: 'text', text: 'terminal' })
    await saveElementScreenshot('#settings-dialog', 'dialog-input-text-selection.png')
    await $('#settings-close').click()
    await expect($('#settings-dialog')).not.toBeDisplayed()
  })
})
