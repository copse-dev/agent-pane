import { at } from '@copse/std/array-utils.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedFooterBranchPickerFixture } from './helpers/seed-config.ts'
import { seedBranchWorkspace } from './helpers/branch-workspace.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

async function expectPickerContainment(): Promise<void> {
  // Filtering resizes the popup; let CSS anchor fallbacks settle before measuring it.
  await browser.execute(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            done()
          }),
        )
      }),
  )
  const geometry = await browser.execute(() => {
    const menu = document.querySelector<HTMLElement>('.branch-picker-menu')
    const filter = menu?.querySelector<HTMLElement>('.branch-picker-filter')
    const footer = document.querySelector<HTMLElement>('.input-footer')
    const trigger = document.querySelector<HTMLElement>('.branch-picker-trigger')
    if (!menu || !filter || !footer || !trigger) return null
    const box = menu.getBoundingClientRect()
    const field = filter.getBoundingClientRect()
    const boundary = footer.getBoundingClientRect()
    const anchor = trigger.getBoundingClientRect()
    const style = getComputedStyle(filter)
    const outline = parseFloat(style.outlineWidth) + Math.max(0, parseFloat(style.outlineOffset))
    const rows = [...menu.querySelectorAll<HTMLElement>('.branch-picker-option')]
    return {
      horizontalGap: Math.abs(
        box.left -
          (footer.classList.contains('is-compact')
            ? boundary.left
            : Math.min(anchor.left, boundary.right - box.width)),
      ),
      verticalGap: anchor.top - box.bottom,
      menuLeft: box.left,
      menuRight: box.right,
      footerLeft: boundary.left,
      footerRight: boundary.right,
      leftInset: field.left - box.left,
      rightInset: box.right - field.right,
      outline,
      menuContained: box.left >= boundary.left - 1 && box.right <= boundary.right + 1,
      rowsContained: rows.every((row) => {
        const rect = row.getBoundingClientRect()
        return rect.left >= box.left && rect.right <= box.right
      }),
      badgesContained: [
        ...menu.querySelectorAll<HTMLElement>('.branch-picker-default-badge'),
      ].every((badge) => {
        const rect = badge.getBoundingClientRect()
        return rect.left >= box.left && rect.right <= box.right
      }),
    }
  })
  assert.ok(geometry, 'branch picker geometry must exist')
  assert.ok(geometry.leftInset >= geometry.outline, JSON.stringify(geometry))
  assert.ok(geometry.rightInset >= geometry.outline, JSON.stringify(geometry))
  assert.ok(Math.abs(geometry.leftInset - geometry.rightInset) <= 1, JSON.stringify(geometry))
  assert.ok(geometry.menuContained, JSON.stringify(geometry))
  assert.ok(geometry.horizontalGap <= 1, JSON.stringify(geometry))
  assert.ok(geometry.verticalGap >= 3 && geometry.verticalGap <= 5, JSON.stringify(geometry))
  assert.ok(geometry.rowsContained && geometry.badgesContained, JSON.stringify(geometry))
}

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

    const picker = await $('.branch-picker.is-picker-mode').getElement()
    await expect(picker).toBeDisplayed()
    await expect(picker.$('.branch-picker-label')).toHaveText('main')
    await expect(picker.$('.branch-picker-chevron')).toBeDisplayed()

    await picker.$('.branch-picker-trigger').click()
    const menu = await picker.$('.branch-picker-menu').getElement()
    await expect(menu).toBeDisplayed()
    await expect(menu.$('.branch-picker-option')).toBeDisplayed({ wait: 10_000 })
    await expect(menu.$('.branch-picker-action')).not.toExist()

    const branchOptions = await menu.$$('.branch-picker-option').getElements()
    expect(branchOptions.length).toBeGreaterThan(0)
    await expect(at([...branchOptions], 0).$('.branch-picker-default-badge')).toBeDisplayed()

    // The full app, not just #input-bar: the menu opens upward from the footer
    // and can be taller than the composer's own box (the filter row grew it),
    // so an element-scoped capture would clip its top edge.
    await expectPickerContainment()
    await saveAppScreenshot('footer-branch-picker-open.png')
  })

  it('records a picked branch as the thread base without moving the checkout', async () => {
    const picker = await $('.branch-picker.is-picker-mode').getElement()
    const trigger = picker.$('.branch-picker-trigger')
    const menu = picker.$('.branch-picker-menu')
    if (!(await menu.isDisplayed())) await trigger.click()
    await expect(menu).toBeDisplayed()
    await expect(menu.$('.branch-picker-option')).toBeDisplayed({ wait: 10_000 })

    // The isolated fixture has a default branch and a checked-out work branch.
    let picked: string | null = null
    for (const option of await menu.$$('.branch-picker-option').getElements()) {
      const name = await option.$('.branch-picker-option-label').getText()
      if (name === 'main') continue
      picked = name
      await option.click()
      break
    }
    assert.ok(picked, 'expected a branch other than the default to pick')

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

    await saveAppScreenshot('footer-branch-picker-pending.png')
  })

  it('filters branches, navigates with the keyboard, and reports a no-match state', async () => {
    const picker = await $('.branch-picker.is-picker-mode').getElement()
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
    await browser.waitUntil(
      async () => (await menu.$$('.branch-picker-option').getElements()).length === 1,
      {
        timeout: 2_000,
        timeoutMsg: 'branch picker did not filter after typing',
      },
    )
    await expect(menu.$('.branch-picker-option-label')).toHaveText(seed.currentBranch)

    await expectPickerContainment()
    await saveAppScreenshot('footer-branch-picker-filtered.png')

    // Clearing the filter restores the full list; keyboard nav plus Enter selects.
    await filter.click()
    await browser.keys(Array(seed.currentBranch.length).fill('Backspace'))
    await browser.waitUntil(
      async () => (await menu.$$('.branch-picker-option').getElements()).length === 2,
      {
        timeout: 2_000,
        timeoutMsg: 'branch picker did not restore the full list',
      },
    )
    await browser.keys('ArrowDown')
    const activeId = await filter.getAttribute('aria-activedescendant')
    assert.ok(activeId, 'the filter exposes the keyboard-highlighted option')
    const activeOption = await browser.execute((id: string) => {
      const option = document.getElementById(id)
      return { role: option?.getAttribute('role'), active: option?.classList.contains('is-active') }
    }, activeId)
    assert.deepEqual(activeOption, { role: 'option', active: true })
    await expect(filter).toBeFocused()
    await browser.keys('Enter')
    await expect(menu).not.toBeDisplayed()
    await expect(trigger.$('.branch-picker-label')).toHaveText(seed.currentBranch)
    await expect(trigger).toBeFocused()
    // The app-shell screenshot helper dispatches resize, which returns focus
    // to the composer. The viewport was already pinned by the preceding
    // capture, so take this frame directly while the real trigger focus is
    // still present.
    await browser.pause(100)
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'footer-branch-picker-keyboard-focus.png'))

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

  it('contains the filter and long branch rows at normal and compact widths', async () => {
    const longBranch = 'feature/a-long-branch-name-that-must-stay-inside-the-picker-popup'
    execFileSync('git', ['branch', longBranch], { cwd: root })
    seed = seedFooterBranchPickerFixture(root)
    writeE2eEnv({ COPSE_PANEL_MOCK_BRANCH: '' })
    await browser.reloadSession()
    const trigger = $('.branch-picker-trigger')
    await trigger.waitForDisplayed({ timeout: 10_000 })
    const menu = $('.branch-picker-menu')
    await trigger.click()
    await expect(menu.$('.branch-picker-default-badge')).toBeDisplayed()
    await expectPickerContainment()
    const filter = menu.$('.branch-picker-filter')
    await filter.setValue(longBranch)
    await expect(menu.$('.branch-picker-option-label')).toHaveText(longBranch, { wait: 2000 })
    await expectPickerContainment()
    await saveAppScreenshot('footer-branch-picker-long-filter.png')
    await expectPickerContainment()
    await browser.keys('Escape')

    try {
      for (const width of [320, 220]) {
        await browser.execute((width) => {
          const pane = document.getElementById('pane-chat')
          if (!pane) throw new Error('chat pane must exist')
          pane.style.flex = '0 0 auto'
          pane.style.width = `${String(width)}px`
          pane.style.maxWidth = `${String(width)}px`
        }, width)
        await browser.waitUntil(
          async () =>
            (await $('.input-footer').getAttribute('class'))?.includes('is-compact') ?? false,
          { timeout: 3000, timeoutMsg: 'narrow owning footer must enter compact mode' },
        )
        await trigger.click()
        await expect(menu).toBeDisplayed()
        await expect(menu.$('.branch-picker-default-badge')).toBeDisplayed()
        await expectPickerContainment()
        await filter.setValue(longBranch)
        await expect(menu.$('.branch-picker-option-label')).toHaveText(longBranch)
        await expectPickerContainment()
        await saveAppScreenshot(`footer-branch-picker-compact-${String(width)}.png`)
        await expectPickerContainment()
        await browser.keys('Escape')
      }
    } finally {
      await browser.execute(() => {
        const pane = document.getElementById('pane-chat')
        if (!pane) return
        pane.style.flex = ''
        pane.style.width = ''
        pane.style.maxWidth = ''
      })
    }
  })
})
