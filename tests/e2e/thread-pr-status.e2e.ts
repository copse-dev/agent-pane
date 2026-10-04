import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedThreadPrStatusFixture } from './helpers/seed-config.ts'

describe('thread GitHub PR status icon', () => {
  let openThreadTitle: string
  let mergedThreadTitle: string
  let plainThreadTitle: string
  let failingThreadTitle: string

  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({ COPSE_PANEL_MOCK_GH: '1', COPSE_PANEL_MOCK_GH_STATUS: 'ready' })
    resetUserData()
    ;({ openThreadTitle, mergedThreadTitle, plainThreadTitle, failingThreadTitle } =
      seedThreadPrStatusFixture(process.cwd()))
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows open and merged PR icons on linked threads', async function () {
    this.timeout(90_000)

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await expect($('.chat-row.selected .chat-title')).toHaveText(openThreadTitle)

    const openIcon = await $('.chat-row.selected .chat-pr-status').getElement()
    await openIcon.waitForExist({ timeout: 15_000 })
    await expect(openIcon).toHaveElementClass('is-open')
    await expect(openIcon.$('svg[data-icon="git-pull-request"]')).toExist()
    await expect(openIcon).toHaveAttribute('aria-label', expect.stringMatching(/#42.*open/i))

    // Threads that were never opened this session carry no PR refs yet; open
    // the merged one so its icon resolves alongside the open one.
    await $(`.chat-row[data-thread-id="e2e-pr-merged-thread"]`).click()
    await $(`.chat-row[data-thread-id="e2e-pr-failing-thread"]`).click()
    await browser.waitUntil(
      async () =>
        (await $$('.chats-list .chat-pr-status.is-open.has-ci-failure').getElements()).length > 0,
      { timeout: 15_000, timeoutMsg: 'failing-CI dot never appeared' },
    )
    await browser.waitUntil(
      async () => (await $$('.chats-list .chat-pr-status.is-merged').getElements()).length > 0,
      {
        timeout: 15_000,
        timeoutMsg: 'merged PR icon never resolved',
      },
    )

    const labels = await browser.execute(
      (openTitle, mergedTitle, plainTitle) => {
        const rows = [...document.querySelectorAll<HTMLElement>('.chats-list .chat-row')]
        const byTitle = (title: string): HTMLElement | undefined =>
          rows.find((r) => r.querySelector('.chat-title')?.textContent === title)
        const open = byTitle(openTitle)?.querySelector('.chat-pr-status')
        const merged = byTitle(mergedTitle)?.querySelector('.chat-pr-status')
        const plain = byTitle(plainTitle)?.querySelector('.chat-pr-status')
        return {
          openKind: open?.classList.contains('is-open') ?? false,
          openIcon: open?.querySelector('svg')?.getAttribute('data-icon') ?? null,
          openLabel: open?.getAttribute('aria-label') ?? null,
          mergedKind: merged?.classList.contains('is-merged') ?? false,
          mergedIcon: merged?.querySelector('svg')?.getAttribute('data-icon') ?? null,
          mergedLabel: merged?.getAttribute('aria-label') ?? null,
          plainHasIcon: Boolean(plain),
        }
      },
      openThreadTitle,
      mergedThreadTitle,
      plainThreadTitle,
    )

    expect(labels.openKind).toBe(true)
    expect(labels.openIcon).toBe('git-pull-request')
    expect(labels.openLabel).toMatch(/#42.*open/i)
    expect(labels.mergedKind).toBe(true)
    expect(labels.mergedIcon).toBe('git-merge')
    expect(labels.mergedLabel).toMatch(/merged/i)
    expect(labels.plainHasIcon).toBe(false)

    // Merged follows GitHub's purple, distinct from the open (accent) and success hues.
    const colours = await browser.execute(() => {
      const resolve = (value: string): string => {
        const probe = document.createElement('span')
        probe.style.color = value
        document.body.appendChild(probe)
        const out = getComputedStyle(probe).color
        probe.remove()
        return out
      }
      const colourOf = (selector: string): string | null => {
        const el = document.querySelector(selector)
        return el ? getComputedStyle(el).color : null
      }
      return {
        merged: colourOf('.chat-pr-status.is-merged'),
        open: colourOf('.chat-pr-status.is-open'),
        important: resolve('var(--pr-merged)'),
        success: resolve('var(--success)'),
      }
    })
    expect(colours.merged).toBe(colours.important)
    expect(colours.merged).not.toBe(colours.success)
    expect(colours.merged).not.toBe(colours.open)

    // Only the red-checks PR carries the dot; the green open PR must not.
    const dots = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>('.chats-list .chat-row')].map((row) => ({
        title: row.querySelector('.chat-title')?.textContent ?? '',
        failing: row.querySelector('.chat-pr-status.has-ci-failure') !== null,
      })),
    )
    expect(dots.filter((d) => d.failing).map((d) => d.title)).toEqual([failingThreadTitle])

    await saveElementScreenshot('#pane-projects', 'thread-pr-status-icon.png')
  })

  it('uses the same lifecycle glyph and colours in the PR panel', async function () {
    this.timeout(90_000)
    await $('.chat-row[data-thread-id="e2e-pr-merged-thread"]').click()
    const pane = await $('#pane-files')
    if (!(await pane.isDisplayed())) {
      await $('.titlebar-panel-controls .titlebar-btn[aria-label="Toggle right panel"]').click()
      await pane.waitForDisplayed({ timeout: 10_000 })
    }
    await $('[aria-label="Open pull requests"]').click()
    const merged = await $('.pr-list-row[data-pr-section="linked"] .pr-list-status.is-merged')
    await merged.waitForDisplayed({ timeout: 15_000 })
    await expect(merged.$('svg[data-icon="git-merge"]')).toExist()
    await expect(merged).toHaveAttribute('aria-label', expect.stringMatching(/#99 merged/i))
    await expect($('.pr-list-status.is-open.has-ci-failure')).toBeDisplayed()
    await expect($('.pr-list-ci')).not.toBeExisting()

    const status = await browser.execute(() => {
      const sidebar = document.querySelector('.chat-row.selected .chat-pr-status')
      const paneIcon = document.querySelector('.pr-list-status.is-merged')
      const failing = document.querySelector('.pr-list-status.has-ci-failure svg path:nth-child(2)')
      const sidebarFailing = document.querySelector(
        '.chats-list .has-ci-failure svg path:nth-child(2)',
      )
      const title = document.querySelector('.pr-list-row[data-pr-section="linked"] .pr-list-title')
      return {
        sidebarColour: sidebar ? getComputedStyle(sidebar).color : null,
        paneColour: paneIcon ? getComputedStyle(paneIcon).color : null,
        failureFill: failing ? getComputedStyle(failing).fill : null,
        sidebarFailureFill: sidebarFailing ? getComputedStyle(sidebarFailing).fill : null,
        iconWidth: paneIcon?.getBoundingClientRect().width ?? 0,
        sidebarIconWidth: sidebar?.getBoundingClientRect().width ?? 0,
        overlapsTitle: Boolean(
          title &&
          paneIcon &&
          title.getBoundingClientRect().bottom > paneIcon.getBoundingClientRect().top &&
          title.getBoundingClientRect().right > paneIcon.getBoundingClientRect().left,
        ),
      }
    })
    expect(status.paneColour).not.toBeNull()
    expect(status.paneColour).toBe(status.sidebarColour)
    expect(status.failureFill).not.toBeNull()
    expect(status.failureFill).toBe(status.sidebarFailureFill)
    expect(status.iconWidth).toBeGreaterThan(0)
    expect(status.iconWidth).toBe(status.sidebarIconWidth)
    expect(status.overlapsTitle).toBe(false)
    await saveElementScreenshot('#pane-files', 'pr-panel-status-icons.png')
  })

  it('shows a red conflict X in both panels when details establish conflicts', async function () {
    this.timeout(90_000)
    await $('.chat-row[data-thread-id="e2e-pr-conflict-thread"]').click()
    const linked = await $('.pr-list-row[data-pr-section="linked"]')
    await expect(linked.$('.pr-list-number')).toHaveText('#100')
    await linked.click()
    await expect($('.pr-viewer-title')).toHaveText('Resolve conflicting changes')
    const sidebar = await $('.chat-row.selected .chat-pr-status.has-conflicts')
    const row = await $('.pr-list-row[data-pr-section="linked"] .pr-list-status.has-conflicts')
    await sidebar.waitForDisplayed({ timeout: 15_000 })
    await row.waitForDisplayed({ timeout: 15_000 })
    await expect(sidebar).toHaveAttribute('aria-label', expect.stringMatching(/merge conflicts/i))
    await expect(row).toHaveAttribute('aria-label', expect.stringMatching(/merge conflicts/i))
    await expect(row).not.toHaveElementClass('has-ci-failure')
    await expect(row.$('svg path:nth-child(2)')).toHaveAttribute('d', 'M3 3l6 6m0-6L3 9')
    const styles = await browser.execute(() => {
      const mark = document.querySelector('.pr-list-status.has-conflicts svg path:nth-child(2)')
      const sidebarMark = document.querySelector(
        '.chat-row.selected .has-conflicts svg path:nth-child(2)',
      )
      return {
        fill: mark ? getComputedStyle(mark).fill : null,
        stroke: mark ? getComputedStyle(mark).stroke : null,
        sidebarStroke: sidebarMark ? getComputedStyle(sidebarMark).stroke : null,
      }
    })
    expect(styles.fill).toBe('none')
    expect(styles.stroke).not.toBeNull()
    expect(styles.stroke).toBe(styles.sidebarStroke)
    await saveElementScreenshot('#pane-projects', 'thread-pr-conflict-icon.png')
    await saveElementScreenshot('#pane-files', 'pr-panel-conflict-icon.png')
  })
})
