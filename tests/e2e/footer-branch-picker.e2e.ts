import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedFooterBranchPickerFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('footer branch picker', () => {
  let seed: ReturnType<typeof seedFooterBranchPickerFixture>

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seed = seedFooterBranchPickerFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the picker on a new chat with default branch first', async () => {
    await $('.input-footer').waitForExist({ timeout: 30_000 })

    const picker = await $('.branch-picker.is-picker-mode')
    await expect(picker).toBeDisplayed()
    await expect(picker.$('.branch-picker-label')).toHaveText(seed.currentBranch)
    await expect(picker.$('.branch-picker-chevron')).toBeDisplayed()

    await picker.$('.branch-picker-trigger').click()
    const menu = await picker.$('.branch-picker-menu')
    await expect(menu).toBeDisplayed()
    await expect(menu.$('.branch-picker-option')).toBeDisplayed({ wait: 10_000 })
    await expect(menu.$('.branch-picker-action')).not.toBeDisplayed()

    const branchOptions = await menu.$$('.branch-picker-option')
    await expect(branchOptions.length).toBeGreaterThan(0)
    await expect(branchOptions[0].$('.branch-picker-default-badge')).toBeDisplayed()

    const inputBar = await $('#input-bar')
    await inputBar.saveScreenshot(join(SCREENSHOT_DIR, 'footer-branch-picker-open.png'))
  })
})
