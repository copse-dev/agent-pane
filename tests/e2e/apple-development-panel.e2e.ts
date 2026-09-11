import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedAppleDevelopmentFixture } from './helpers/seed-config.ts'

const describeAppleDevelopment = process.platform === 'darwin' ? describe : describe.skip

describeAppleDevelopment('Apple Development thread panel', function () {
  this.timeout(60_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedAppleDevelopmentFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders a compact enrolled target and its actionable result', async () => {
    const panel = $('.apple-development-panel[data-plugin-id="copse.apple-development"]')
    await panel.waitForDisplayed({ timeout: 30_000 })
    await expect(panel.$('.apple-development-title')).toHaveText('Apple development')
    await expect(panel.$('.apple-development-status')).toHaveText('Target saved')
    await expect(panel.$('.apple-development-discover')).toHaveAttribute(
      'aria-label',
      'Refresh targets',
    )
    await expect(panel.$('.apple-development-discover svg')).toExist()
    await expect(panel.$('[aria-label="Selected Apple target"]')).toHaveText(
      expect.stringContaining('ios/DemoApp.xcworkspace'),
    )
    assert.doesNotMatch(await panel.getText(), /Xcode targets are revalidated/)

    await expect(panel.$$('.apple-development-operation')).toBeElementsArrayOfSize(1)
    await expect(panel.$('.apple-development-operation-status')).toHaveText('Failed · 1s')
    await expect(panel.$('[data-operation-id="test-demo"]')).toHaveText(
      expect.stringContaining(
        'DemoAppTests/BrowserTests.swift:42:13: error: XCTAssertEqual failed',
      ),
    )
    const actions = panel.$('.apple-development-actions')
    await expect(actions.$('button=Build')).toBeEnabled()
    await expect(actions.$('button=Test')).toBeEnabled()
    await expect(actions.$('button=Run')).toBeEnabled()
    await expect(panel.$('[data-operation-id="run-demo"]')).not.toExist()
    await expect(panel.$('[data-operation-id="build-demo"]')).not.toExist()
    assert.doesNotMatch(await panel.getText(), /error:\s*permissionDenied/)

    await saveAppScreenshot('apple-development-test-profile.png')

    const detection = await browser.execute(() =>
      window.api.appleDevelopment.detectProject('e2e-apple-development-project'),
    )
    assert.equal(detection.enrolled, true)
    assert.equal(detection.supportedHost, true)
    const projectMenu = $(
      '.project-entry[data-project-id="e2e-apple-development-project"] .project-menu-btn',
    )
    await projectMenu.click()
    await expect($('.context-menu-item=Apple Development…')).toBeDisplayed()
    await saveAppScreenshot('apple-development-project-menu.png')
    await $('.context-menu-item=Apple Development…').click()
    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    const pluginRow = dialog.$('.plugin-row[data-plugin-id="copse.apple-development"]')
    await pluginRow.waitForDisplayed({ timeout: 15_000 })
    await expect(pluginRow.$('.plugin-name')).toHaveText('Apple development')
    const settingsFold = pluginRow.$('.plugin-settings-fold')
    await expect(settingsFold).toHaveAttribute('open')
    await expect(pluginRow.$('.apple-development-panel')).toBeDisplayed()
    await expect(pluginRow.$('.apple-development-panel').$('button=Remove project')).toBeDisplayed()
    await saveAppScreenshot('apple-development-enrollment-settings.png')
  })
})
