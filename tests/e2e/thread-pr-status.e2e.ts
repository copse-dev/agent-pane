import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedThreadPrStatusFixture } from './helpers/seed-config.ts'

describe('thread GitHub PR status icon', () => {
  let openThreadTitle: string
  let mergedThreadTitle: string
  let plainThreadTitle: string

  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({ COPSE_PANEL_MOCK_GH: '1', COPSE_PANEL_MOCK_GH_STATUS: 'ready' })
    resetUserData()
    ;({ openThreadTitle, mergedThreadTitle, plainThreadTitle } = seedThreadPrStatusFixture(
      process.cwd(),
    ))
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows open and merged PR icons on linked threads', async function () {
    this.timeout(90_000)

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await expect($('.chat-row.selected .chat-title')).toHaveText(openThreadTitle)

    const openIcon = await $('.chat-row.selected .chat-pr-status')
    await openIcon.waitForExist({ timeout: 15_000 })
    await expect(openIcon).toHaveElementClass('is-open')
    await expect(openIcon.$('svg[data-icon="git-pull-request"]')).toExist()
    await expect(openIcon).toHaveAttribute('aria-label', expect.stringMatching(/#42.*open/i))

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

    await expect(labels.openKind).toBe(true)
    await expect(labels.openIcon).toBe('git-pull-request')
    await expect(labels.openLabel).toMatch(/#42.*open/i)
    await expect(labels.mergedKind).toBe(true)
    await expect(labels.mergedIcon).toBe('git-pull-request')
    await expect(labels.mergedLabel).toMatch(/merged/i)
    await expect(labels.plainHasIcon).toBe(false)

    await saveElementScreenshot('#pane-projects', 'thread-pr-status-icon.png')
  })
})
