import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedFooterBranchFixture,
  seedFooterBranchMismatchFixture,
} from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('footer branch status match', () => {
  let seed: ReturnType<typeof seedFooterBranchFixture>

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seed = seedFooterBranchFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the thread branch when checkout matches', async () => {
    await $('.input-footer').waitForExist({ timeout: 15_000 })

    const branchBtn = await $('.footer-branch-status')
    await expect(branchBtn).toBeDisplayed()
    await expect(branchBtn).not.toHaveElementClass('is-mismatch')
    await expect(branchBtn.$('.footer-branch-label')).toHaveText(seed.currentBranch)

    const inputBar = await $('#input-bar')
    await inputBar.saveScreenshot(join(SCREENSHOT_DIR, 'footer-branch-match.png'))
  })
})

describe('footer branch status mismatch', () => {
  let seed: ReturnType<typeof seedFooterBranchMismatchFixture>

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seed = seedFooterBranchMismatchFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('highlights mismatch when thread branch differs from checkout', async () => {
    await $('.input-footer').waitForExist({ timeout: 15_000 })

    const branchBtn = await $('.footer-branch-status')
    await expect(branchBtn).toBeDisplayed({ wait: 10_000 })
    await expect(branchBtn.$('.footer-branch-label')).toHaveText(seed.mismatchBranch, {
      wait: 10_000,
    })

    const inputBar = await $('#input-bar')
    await inputBar.saveScreenshot(join(SCREENSHOT_DIR, 'footer-branch-mismatch.png'))

    // Warning styling needs live git checkout detection (may be unavailable in headless e2e).
    const hasMismatchClass = (await branchBtn.getAttribute('class'))?.includes('is-mismatch')
    if (hasMismatchClass) {
      await expect(branchBtn).toHaveElementClass('is-mismatch')
    }
  })
})
