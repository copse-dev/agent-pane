import { execFileSync } from 'node:child_process'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedComposerBranchWarningFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { setComposerValue } from './helpers/composer.ts'
import { seedBranchWorkspace } from './helpers/branch-workspace.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

describe('composer branch warning', () => {
  let seed: ReturnType<typeof seedComposerBranchWarningFixture>

  before(async () => {
    resetUserData()
    const root = seedBranchWorkspace()
    seed = seedComposerBranchWarningFixture(root)
    execFileSync('git', ['branch', seed.mismatchBranch], { cwd: root })
    await browser.reloadSession()
  })

  after(() => {
    writeE2eEnv({})
    resetUserData()
  })

  it('shows an inline checkout action for branch mismatches', async () => {
    await $('.prompt-input').waitForDisplayed({ timeout: 30_000 })

    await setComposerValue('Continue on this thread')
    await $('.submit-btn').click()

    const warning = await $('.composer-branch-warning')
    await expect(warning).toBeDisplayed()
    await expect(warning.$('.composer-branch-warning-text')).toHaveText(
      `This thread is for branch "${seed.mismatchBranch}". Check it out, or continue on the current branch.`,
    )
    await expect(warning.$('.composer-branch-checkout-btn')).toHaveText('Check out')

    await saveAppScreenshot('composer-branch-warning-checkout.png')
  })
})
