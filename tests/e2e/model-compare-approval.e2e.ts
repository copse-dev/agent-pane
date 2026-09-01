import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('model comparison approval', function () {
  this.timeout(60_000)
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    // The experimental `compare_models` tool ships off, so this flow must seed
    // the `copse.model-comparison` plugin on.
    seedEmptyProject(process.cwd(), 'e2e-model-compare-approval-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      modelComparisonEnabled: true,
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows model pickers on the comparison spend approval dialog', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    await setComposerValue('[[mcp:compare_models {}]]')
    await $('.submit-btn').click()

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })

    await expect(dialog.$('.approval-heading')).toHaveText('Compare models on this diff?')
    await expect(dialog.$('.approval-comparison-models')).toBeDisplayed()
    expect(await dialog.$$('.approval-model-select').length).toBe(3)
    expect(await dialog.$$('.approval-model-picker').length).toBe(3)
    await expect(dialog.$('.approval-comparison-intro')).toHaveText(
      expect.stringContaining('Each reviewer independently reads the working diff'),
    )

    const reviewerA = dialog.$('.approval-model-picker')
    await reviewerA.$('.model-picker-trigger').click()
    await reviewerA.$('.model-picker-option').waitForExist({ timeout: 15_000 })
    const filter = reviewerA.$('.model-picker-filter')
    await filter.setValue('sonnet')
    await browser.waitUntil(async () => (await reviewerA.$$('.model-picker-option')).length === 1, {
      timeout: 2_000,
      timeoutMsg: 'approval model picker did not filter after typing',
    })
    await expect(reviewerA.$('.model-picker-option')).toHaveText(expect.stringContaining('sonnet'))

    await saveElementScreenshot('#approval-dialog', 'model-compare-approval-dialog.png')

    // A second live approval used to join this batch, replacing the interactive
    // comparison controls with a generic two-row prompt. Keep the comparison
    // alone and let the package approval take the next dialog turn.
    await reviewerA.$('.model-picker-trigger').click()
    await browser.execute(() => {
      const bridge = (
        window as unknown as {
          __copseE2e?: { requestAcpPackageInstallApproval: () => Promise<unknown> }
        }
      ).__copseE2e
      if (!bridge?.requestAcpPackageInstallApproval) {
        throw new Error('__copseE2e.requestAcpPackageInstallApproval unavailable')
      }
      void bridge.requestAcpPackageInstallApproval().catch(() => undefined)
    })

    await expect(dialog.$('.approval-heading')).toHaveText('Compare models on this diff?')
    await expect(dialog.$('.approval-comparison-models')).toBeDisplayed()
    expect(await dialog.$$('.approval-model-picker').length).toBe(3)
    await expect(dialog.$('.approval-approve')).toHaveText('Approve')
    await saveElementScreenshot('#approval-dialog', 'model-compare-solo-approval-dialog.png')

    await dialog.$('.approval-reject').click()
    await expect(dialog.$('.approval-heading')).toHaveText('Install ACP adapters globally?')
    expect(await dialog.$$('.approval-model-picker').length).toBe(0)
    await dialog.$('.approval-reject').click()
  })
})
