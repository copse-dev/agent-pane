import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { parkPointer, saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

// Labels in the thread read as labels: the queued badge is sentence case, a
// rolled-up tool summary is upright, and a proposed thread's prompt is prose
// rather than code.
describe('quiet labels in the thread', () => {
  it('shows a queued message with a sentence-case badge', async () => {
    await browser.url('/?scenario=concise-thread-working')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.prompt-input').click()
    await browser.keys('Also check the release notes before you finish')
    await browser.keys('Enter')
    const badge = $('.conversation-queued .message-queued-badge')
    await badge.waitForDisplayed()
    await expect(badge).toHaveText('Queued')
    const style = await browser.execute(() => {
      const el = document.querySelector('.conversation-queued .message-queued-badge')
      return el
        ? {
            transform: getComputedStyle(el).textTransform,
            tracking: getComputedStyle(el).letterSpacing,
          }
        : null
    })
    assert.deepEqual(style, { transform: 'none', tracking: 'normal' })
    await parkPointer()
    await saveElementScreenshot('.conversation-queued', 'queued-badge-sentence-case.png')
  })

  it('sets a rolled-up tool summary upright', async () => {
    await browser.url('/?scenario=concise-thread-disabled')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const rollup = $('.tool-card-rollup')
    await rollup.waitForDisplayed()
    const fontStyle = await browser.execute(() => {
      const name = document.querySelector('.tool-card-rollup > .tool-card-header .tool-name')
      return name ? getComputedStyle(name).fontStyle : null
    })
    assert.equal(fontStyle, 'normal')
    await rollup.scrollIntoView({ block: 'center' })
    await parkPointer()
    await saveElementScreenshot('.tool-card-rollup', 'tool-rollup-upright.png')
  })

  it("reads a proposed thread's prompt as prose", async () => {
    await browser.url('/?scenario=bridged-thread-proposals&autoplay=0')
    await $('.thread-proposal').waitForDisplayed({ timeout: 30_000 })
    await $('.thread-proposal-prompt-summary').click()
    const text = $('.thread-proposal-prompt-text')
    await text.waitForDisplayed()
    const style = await browser.execute(() => {
      const el = document.querySelector('.thread-proposal-prompt-text')
      const body = document.querySelector('.thread-proposal')
      if (!el || !body) return null
      const own = getComputedStyle(el)
      return {
        sameFace: own.fontFamily === getComputedStyle(body).fontFamily,
        border: own.borderTopWidth,
        fill: own.backgroundColor,
      }
    })
    assert.deepEqual(style, { sameFace: true, border: '0px', fill: 'rgba(0, 0, 0, 0)' })
    await $('.thread-proposal').scrollIntoView({ block: 'center' })
    await parkPointer()
    await saveElementScreenshot('.thread-proposal', 'thread-proposal-prompt-prose.png')
  })
})
