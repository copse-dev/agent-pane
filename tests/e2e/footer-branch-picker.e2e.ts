import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedFooterBranchPickerFixture } from './helpers/seed-config.ts'
import { seedBranchWorkspace } from './helpers/branch-workspace.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

describe('footer branch picker', () => {
  let seed: ReturnType<typeof seedFooterBranchPickerFixture>
  let root = ''

  before(async () => {
    resetUserData()
    root = seedBranchWorkspace()
    seed = seedFooterBranchPickerFixture(root)
    await browser.reloadSession()
  })

  after(() => {
    writeE2eEnv({})
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
    await expect(menu.$('.branch-picker-action')).not.toExist()

    const branchOptions = await menu.$$('.branch-picker-option')
    await expect(branchOptions.length).toBeGreaterThan(0)
    await expect(branchOptions[0].$('.branch-picker-default-badge')).toBeDisplayed()

    await saveElementScreenshot('#input-bar', 'footer-branch-picker-open.png')
  })

  it('records a picked branch as the thread base without moving the checkout', async () => {
    const picker = await $('.branch-picker.is-picker-mode')
    const trigger = picker.$('.branch-picker-trigger')
    const menu = picker.$('.branch-picker-menu')
    if (!(await menu.isDisplayed())) await trigger.click()
    await expect(menu).toBeDisplayed()
    await expect(menu.$('.branch-picker-option')).toBeDisplayed({ wait: 10_000 })

    // The isolated fixture has a default branch and a checked-out work branch.
    let picked: string | null = null
    for (const option of await menu.$$('.branch-picker-option')) {
      const name = await option.$('.branch-picker-option-label').getText()
      if (name === seed.currentBranch) continue
      picked = name
      await option.click()
      break
    }
    assert.ok(picked, 'expected a branch other than the current one to pick')

    // Selecting only names the base: the menu closes, the trigger says which
    // branch the thread will start from, and the checkout's PR chip does not
    // get advertised under the pending branch's name.
    await expect(menu).not.toBeDisplayed()
    await expect(trigger.$('.branch-picker-label')).toHaveText(picked)
    await expect(trigger).toHaveAttribute('aria-label', `Start this thread from: ${picked}`)
    await expect(trigger).toHaveAttribute('title', `Start this thread from: ${picked}`)
    await expect(trigger).not.toHaveElementClass('is-link')
    await expect(trigger.$('.branch-picker-label')).not.toHaveText(expect.stringMatching(/^PR #/))
    expect(
      execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe(seed.currentBranch)

    // Reopening shows the pick as selected, still with no PR row for it.
    await trigger.click()
    await expect(menu).toBeDisplayed()
    await expect(
      menu.$('.branch-picker-option.is-selected .branch-picker-option-label'),
    ).toHaveText(picked)
    await expect(menu.$('.branch-picker-action')).not.toExist()
    await browser.keys('Escape')
    await expect(menu).not.toBeDisplayed()

    await saveElementScreenshot('#input-bar', 'footer-branch-picker-pending.png')
  })
})
