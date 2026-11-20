import { $, browser, expect } from '@wdio/globals'
import { setComposerValue } from '../e2e/helpers/composer.ts'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'
import { buildDemoFixturePage } from './helpers/demo-fixture-page.ts'
import { pinDemoClock } from './helpers/fixed-clock.ts'

describe('branch continuation stays with its original chat', () => {
  let page: string

  before(async () => {
    await pinDemoClock()
    page = await buildDemoFixturePage('branch-continuation-fixture')
  })

  for (const otherWarning of [false, true]) {
    it(`keeps the other chat draft${otherWarning ? ' and warning' : ''} after a late response`, async () => {
      await browser.url(`${page}${otherWarning ? '?other-warning' : ''}`)
      await $('.chat-row[data-thread-id="branch-first"].selected').waitForExist()
      await setComposerValue('Continue the first change.')
      await $('.submit-btn').click()
      await expect($('.composer-branch-warning')).toBeDisplayed()
      await $('.composer-branch-continue-btn').click()
      await expect($('body')).toHaveAttribute('data-branch-lookup', 'held')

      await $('.chat-row[data-thread-id="branch-second"]').click()
      await setComposerValue('Keep this second draft for later.')
      if (otherWarning) {
        await $('.submit-btn').click()
        await expect($('.composer-branch-warning')).toBeDisplayed()
        await expect($('.composer-branch-warning')).toHaveText(
          expect.stringContaining('feature/second'),
        )
      }
      await $('#finish-branch-lookup').click()
      await expect($('body')).toHaveAttribute('data-branch-lookup', 'returned')
      await expect($('.chat-row[data-thread-id="branch-second"]')).toHaveElementClass('selected')
      await expect($('.prompt-input')).toHaveText('Keep this second draft for later.')
      await expect($('body')).toHaveAttribute('data-agent-runs', '0')
      if (otherWarning) await expect($('.composer-branch-warning')).toBeDisplayed()
      else await expect($('.composer-branch-warning')).not.toBeDisplayed()
      await expect($('.submit-btn')).toBeEnabled()
      await saveAppScreenshot(
        otherWarning
          ? 'branch-continuation-other-warning.png'
          : 'branch-continuation-other-draft.png',
      )
      await expect($('.prompt-input')).toHaveText('Keep this second draft for later.')
      await expect($('body')).toHaveAttribute('data-agent-runs', '0')
    })
  }

  for (const outcome of ['success', 'error'] as const) {
    it(`keeps the other chat warning and draft after a late checkout ${outcome}`, async () => {
      await browser.url(`${page}?other-warning&checkout=${outcome}`)
      await $('.chat-row[data-thread-id="branch-first"].selected').waitForExist()
      await setComposerValue('Continue the first change.')
      await $('.submit-btn').click()
      await expect($('.composer-branch-warning')).toBeDisplayed()
      await $('.composer-branch-checkout-btn').click()
      await expect($('body')).toHaveAttribute('data-checkout-state', 'held')
      await expect($('body')).toHaveAttribute('data-checkout-project', 'branch-project')
      await expect($('body')).toHaveAttribute('data-checkout-thread', 'branch-first')
      await expect($('body')).toHaveAttribute('data-checkout-branch', 'feature/first')
      await expect($('.composer-branch-checkout-btn')).toBeDisabled()

      await $('.chat-row[data-thread-id="branch-second"]').click()
      await setComposerValue('Keep this second draft for later.')
      await $('.submit-btn').click()
      await expect($('.composer-branch-warning')).toBeDisplayed()
      await expect($('.composer-branch-warning')).toHaveText(
        expect.stringContaining('feature/second'),
      )
      const otherWarning = await $('.composer-branch-warning').getText()
      await $('#finish-branch-checkout').click()
      await expect($('body')).toHaveAttribute('data-checkout-state', 'returned')
      await expect($('.chat-row[data-thread-id="branch-second"]')).toHaveElementClass('selected')
      await expect($('.prompt-input')).toHaveText('Keep this second draft for later.')
      await expect($('.composer-branch-warning')).toBeDisplayed()
      await expect($('.composer-branch-warning')).toHaveText(otherWarning)
      await expect($('.composer-branch-checkout-btn')).toBeEnabled()
      await expect($('.composer-branch-continue-btn')).toBeEnabled()
      await expect($('.toast')).not.toExist()
      await expect($('body')).toHaveAttribute('data-agent-runs', '0')
      await saveAppScreenshot(
        outcome === 'success'
          ? 'branch-checkout-late-success.png'
          : 'branch-checkout-late-error.png',
      )
      await expect($('.prompt-input')).toHaveText('Keep this second draft for later.')
      await expect($('.composer-branch-warning')).toHaveText(otherWarning)
      await expect($('body')).toHaveAttribute('data-agent-runs', '0')
    })
  }
})
