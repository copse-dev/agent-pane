import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('model comparison approval', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
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
    await expect(dialog.$('.approval-comparison-intro')).toHaveText(
      expect.stringContaining('Each reviewer independently reads the working diff'),
    )

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'model-compare-approval-dialog.png'))

    await dialog.$('.approval-reject').click()
  })
})
