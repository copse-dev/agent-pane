import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

describe('settings usage sections', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-usage-sections')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('keeps plan limits, the local ledger and the value map without a plan verdict', async () => {
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()
    await expect($('.usage-plan-provider[data-status="ok"]')).toBeExisting()
    await expect($('.usage-period-body .usage-headline')).toBeExisting()
    await expect($('.frontier-fieldset .frontier-chart > *')).toBeExisting()
    await expect($('.usage-worth-section')).not.toBeExisting()
    await expect($('#usage-worth-fee-input')).not.toBeExisting()

    const headings = await browser.execute(() =>
      [...document.querySelectorAll('.usage-section-root > div > h4')].map((el) => el.textContent),
    )
    assert.deepEqual(headings, ['Subscription plan limits', 'Local usage ledger'])

    await $('.usage-ledger-heading').scrollIntoView({ block: 'center' })
    await prepareE2eScreenshot()
    await saveElementScreenshot('#settings-dialog', 'settings-usage-sections.png')

    const inference = $('.frontier-fieldset [data-plan-coverage="inference"]')
    await inference.scrollIntoView({ block: 'center' })
    await inference.click()
    await expect(inference).toHaveAttribute('aria-pressed', 'true')
    await expect($('.frontier-fieldset [data-plan-coverage="expected"]')).not.toBeExisting()
    await $('.frontier-fieldset [data-plan-coverage="plan"]').click()
    await expect($('.frontier-fieldset [data-plan-coverage="plan"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })
})
