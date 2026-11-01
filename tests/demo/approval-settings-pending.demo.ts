import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('approvals held behind Settings', () => {
  it('offers an actionable notice in Settings and restores the original question', async () => {
    await browser.url('/?scenario=approval-port-binding')
    await $('#approval-dialog').waitForDisplayed()
    await expect($('#approval-dialog .approval-heading')).toHaveText(
      'Allow this project to bind a local port?',
    )

    // Settings is outside the chat-pane approval scrim and remains a real entry path.
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').waitForDisplayed()
    await expect($('#approval-dialog')).not.toBeDisplayed()
    const review = $('.approval-settings-pending')
    await expect(review).toBeDisplayed()
    await expect(review).toHaveText('Review approval')
    const geometry = await browser.execute(() => {
      const header = document.querySelector('.settings-header')?.getBoundingClientRect()
      const review = document.querySelector('.approval-settings-pending')?.getBoundingClientRect()
      if (!header || !review) return null
      return {
        header: { top: header.top, bottom: header.bottom },
        review: { top: review.top, bottom: review.bottom },
      }
    })
    assert.ok(geometry)
    assert.ok(geometry.review.top >= geometry.header.top)
    assert.ok(geometry.review.bottom <= geometry.header.bottom)
    await saveElementScreenshot('#settings-dialog', 'approval-settings-pending.png')

    await review.click()
    await expect($('#settings-dialog')).not.toBeDisplayed()
    await expect($('#approval-dialog')).toBeDisplayed()
    await expect($('#approval-dialog .approval-heading')).toHaveText(
      'Allow this project to bind a local port?',
    )
    await saveElementScreenshot('#approval-dialog', 'approval-settings-restored.png')
  })
})
