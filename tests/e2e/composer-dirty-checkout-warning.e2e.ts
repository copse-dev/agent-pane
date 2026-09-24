import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedComposerDirtyWarningFixture,
  cleanupComposerDirtyWarningFixture,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, prepareE2eScreenshot } from './helpers/screenshot.ts'
import { setComposerValue } from './helpers/composer.ts'

describe('composer dirty checkout warning', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedComposerDirtyWarningFixture()
    await browser.reloadSession()
  })

  after(() => {
    cleanupComposerDirtyWarningFixture()
    resetUserData()
  })

  it('warns before the first prompt lands on a dirty shared checkout', async () => {
    await $('.prompt-input').waitForDisplayed({ timeout: 30_000 })

    await setComposerValue('Refactor the parser')
    await $('.submit-btn').click()

    const warning = await $('.composer-dirty-warning')
    await expect(warning).toBeDisplayed()
    await expect(warning.$('.composer-dirty-warning-text')).toHaveText(
      'This checkout has uncommitted changes. Work will run on top of them.',
    )
    await expect(warning.$('.composer-dirty-worktree-btn')).toHaveText('Use an isolated worktree')
    await expect(warning.$('.composer-dirty-send-btn')).toHaveText('Send anyway')

    // Nothing was sent yet: the message stays in the composer, not the transcript.
    await expect($('.msg-user')).not.toBeExisting()

    await prepareE2eScreenshot()
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'composer-dirty-checkout-warning.png'))
  })
})
