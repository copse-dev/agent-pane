import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

describe('settings alerts', function () {
  this.timeout(90_000)
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-alerts')
    seedE2eViewport(
      { width: 1280, height: 800 },
      {
        alertOnInteraction: true,
        alertOnThreadFinished: false,
        alertSystemNotification: true,
        alertSound: false,
        alertBounce: false,
      },
    )
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows and independently persists event and delivery controls', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="appearance"]').click()

    const alerts = await $('[data-testid="settings-alerts"]')
    await alerts.waitForDisplayed({ timeout: 30_000 })
    await expect(alerts.$('legend')).toHaveText('Alerts')
    await expect(alerts.$$('label')).toBeElementsArrayOfSize(5)
    await expect(alerts.$$('label')[0]).toHaveText('Thread needs interaction')
    await expect(alerts.$$('label')[1]).toHaveText('Thread finishes')
    await expect(alerts.$$('label')[2]).toHaveText('System notification')
    await expect(alerts.$$('label')[3]).toHaveText('Sound')
    await expect(alerts.$$('label')[4]).toHaveText('Dock or taskbar animation')
    await expect(alerts.$('input[name="alertOnInteraction"]')).toBeChecked()
    await expect(alerts.$('input[name="alertOnThreadFinished"]')).not.toBeChecked()
    await expect(alerts.$('input[name="alertSystemNotification"]')).toBeChecked()
    await expect(alerts.$('input[name="alertSound"]')).not.toBeChecked()
    await expect(alerts.$('input[name="alertBounce"]')).not.toBeChecked()

    await alerts.$('input[name="alertOnThreadFinished"]').click()
    await alerts.$('input[name="alertSound"]').click()
    await saveElementScreenshot('#settings-dialog', 'settings-alerts.png')
    await $('.settings-buttons button[type="submit"]').click()
    await $('#settings-dialog').waitForDisplayed({ reverse: true, timeout: 30_000 })

    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="appearance"]').click()
    await expect($('input[name="alertOnThreadFinished"]')).toBeChecked()
    await expect($('input[name="alertSound"]')).toBeChecked()
    await expect($('input[name="alertBounce"]')).not.toBeChecked()
  })
})
