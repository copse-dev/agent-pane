import { execFileSync } from 'node:child_process'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedComposerBranchWarningFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { composerBannerMetrics } from './helpers/composer-banner.ts'
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

    // The same banner-action box as every other composer strip. Check out takes
    // the warning tone; Continue here is the advisory alternative and stays
    // neutral until hovered.
    const metrics = await composerBannerMetrics('.composer-branch-warning')
    if (!metrics) throw new Error('branch warning not found')
    await expect(metrics.padding).toBe('8px 12px')
    await expect(metrics.fontSize).toBe('12px')
    await expect(metrics.actions).toEqual([
      {
        label: 'Check out',
        padding: '4px 8px',
        fontSize: '12px',
        radius: '6px',
        edge: metrics.edges.warning,
      },
      {
        label: 'Continue here',
        padding: '4px 8px',
        fontSize: '12px',
        radius: '6px',
        edge: metrics.edges.neutral,
      },
    ])

    await saveAppScreenshot('composer-branch-warning-checkout.png')
    await saveElementScreenshot('.composer-branch-warning', 'composer-branch-warning-actions.png')
  })
})
