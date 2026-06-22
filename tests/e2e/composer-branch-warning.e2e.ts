import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedComposerBranchWarningFixture } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

describe('composer branch warning', () => {
  let seed: ReturnType<typeof seedComposerBranchWarningFixture>

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seed = seedComposerBranchWarningFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows an inline checkout action for branch mismatches', async () => {
    await $('.prompt-input').waitForDisplayed({ timeout: 15_000 })

    await $('.prompt-input').setValue('Continue on this thread')
    await $('.submit-btn').click()

    const warning = await $('.composer-branch-warning')
    await expect(warning).toBeDisplayed()
    await expect(warning.$('.composer-branch-warning-text')).toHaveText(
      `This thread is for branch "${seed.mismatchBranch}". Check out that branch to continue.`,
    )
    await expect(warning.$('.composer-branch-checkout-btn')).toHaveText('Check out')

    await saveElementScreenshot('#input-bar', 'composer-branch-warning-checkout.png')
  })
})
