import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedFooterBranchPickerFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

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
    await expect(menu.$('.branch-picker-action')).not.toExist()

    const branchOptions = await menu.$$('.branch-picker-option')
    await expect(branchOptions.length).toBeGreaterThan(0)
    await expect(branchOptions[0].$('.branch-picker-default-badge')).toBeDisplayed()

    // The full app, not just #input-bar: the menu opens upward from the footer
    // and can be taller than the composer's own box (the filter row grew it),
    // so an element-scoped capture would clip its top edge.
    await saveAppScreenshot('footer-branch-picker-open.png')
  })

  it('records a picked branch as the thread base without moving the checkout', async () => {
    const picker = await $('.branch-picker.is-picker-mode')
    const trigger = picker.$('.branch-picker-trigger')
    const menu = picker.$('.branch-picker-menu')
    if (!(await menu.isDisplayed())) await trigger.click()
    await expect(menu).toBeDisplayed()
    await expect(menu.$('.branch-picker-option')).toBeDisplayed({ wait: 10_000 })

    // The e2e branch mock lists the reported branch plus the default, so there
    // is always exactly one option that is not the checkout's own branch.
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

    // Reopening shows the pick as selected, still with no PR row for it.
    await trigger.click()
    await expect(menu).toBeDisplayed()
    await expect(
      menu.$('.branch-picker-option.is-selected .branch-picker-option-label'),
    ).toHaveText(picked)
    await expect(menu.$('.branch-picker-action')).not.toExist()
    await browser.keys('Escape')
    await expect(menu).not.toBeDisplayed()

    await saveAppScreenshot('footer-branch-picker-pending.png')
  })

  it('filters branches, navigates with the keyboard, and reports a no-match state', async () => {
    const picker = await $('.branch-picker.is-picker-mode')
    const trigger = picker.$('.branch-picker-trigger')
    const menu = picker.$('.branch-picker-menu')
    if (!(await menu.isDisplayed())) await trigger.click()
    await expect(menu).toBeDisplayed()
    await expect(menu.$('.branch-picker-option')).toBeDisplayed({ wait: 10_000 })

    const filter = menu.$('.branch-picker-filter')
    await expect(filter).toBeDisplayed()
    await expect(filter).toBeFocused()

    // Case-insensitive substring narrows the list to the one matching branch.
    await filter.setValue(seed.currentBranch.toUpperCase())
    await browser.waitUntil(async () => (await menu.$$('.branch-picker-option')).length === 1, {
      timeout: 2_000,
      timeoutMsg: 'branch picker did not filter after typing',
    })
    await expect(menu.$('.branch-picker-option-label')).toHaveText(seed.currentBranch)

    await saveAppScreenshot('footer-branch-picker-filtered.png')

    // Clearing the filter restores the full list; keyboard nav plus Enter selects.
    await filter.setValue('')
    await browser.waitUntil(async () => (await menu.$$('.branch-picker-option')).length === 2, {
      timeout: 2_000,
      timeoutMsg: 'branch picker did not restore the full list',
    })
    await browser.keys('ArrowDown')
    await browser.keys('Enter')
    await expect(menu).not.toBeDisplayed()
    await expect(trigger.$('.branch-picker-label')).toHaveText(seed.currentBranch)

    // A query matching nothing reports an empty state instead of a blank menu.
    await trigger.click()
    await expect(menu).toBeDisplayed()
    const filter2 = menu.$('.branch-picker-filter')
    await filter2.setValue('no-such-branch')
    await expect(menu.$('.branch-picker-empty')).toHaveText('No branches match "no-such-branch".', {
      wait: 2_000,
    })
    await expect(menu.$('.branch-picker-option')).not.toExist()

    await browser.keys('Escape')
    await expect(menu).not.toBeDisplayed()
  })
})
