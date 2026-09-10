import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedAppleDevelopmentFixture } from './helpers/seed-config.ts'

describe('Apple Development thread panel', function () {
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

    const operations = panel.$$('.apple-development-operation')
    await expect(operations).toBeElementsArrayOfSize(1)
    assert.deepEqual(
      await Promise.all(
        operations.map((item) => item.$('.apple-development-operation-status').getText()),
      ),
      ['Failed · 1s'],
    )
    await expect(panel.$('[data-operation-id="test-demo"]')).toHaveText(
      expect.stringContaining(
        'DemoAppTests/BrowserTests.swift:42:13: error: XCTAssertEqual failed',
      ),
    )
    await expect(panel.$('.apple-development-actions button=Build')).toBeEnabled()
    await expect(panel.$('.apple-development-actions button=Test')).toBeEnabled()
    await expect(panel.$('.apple-development-actions button=Run')).toBeEnabled()
    await expect(panel.$('[data-operation-id="run-demo"]')).not.toExist()
    await expect(panel.$('[data-operation-id="build-demo"]')).not.toExist()
    assert.doesNotMatch(await panel.getText(), /error:\s*permissionDenied/)

    await saveAppScreenshot('apple-development-test-profile.png')

    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="customise"]').click()
    const pluginRow = dialog.$('.plugin-row[data-plugin-id="copse.apple-development"]')
    await pluginRow.waitForDisplayed({ timeout: 15_000 })
    await expect(pluginRow.$('.plugin-name')).toHaveText('Apple Development')
    const settingsFold = pluginRow.$('.plugin-settings-fold')
    await settingsFold.$('summary').click()
    await expect(pluginRow.$('.apple-development-panel')).toBeDisplayed()
    await expect(pluginRow.$('button=Remove project')).toBeDisplayed()
    await saveAppScreenshot('apple-development-enrollment-settings.png')
  })
})
