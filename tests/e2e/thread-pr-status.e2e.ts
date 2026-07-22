import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedThreadPrStatusFixture } from './helpers/seed-config.ts'

describe('thread GitHub PR status chips', () => {
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

  it('shows open and merged chips on linked threads', async function () {
    this.timeout(90_000)

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await expect($('.chat-row.selected .chat-title')).toHaveText(openThreadTitle)

    const openChip = await $('.chat-row.selected .chat-pr-status')
    await openChip.waitForExist({ timeout: 15_000 })
    await expect(openChip).toHaveText('#42')
    await expect(openChip).toHaveElementClass('is-open')

    const labels = await browser.execute(
      (openTitle, mergedTitle, plainTitle) => {
        const rows = [...document.querySelectorAll<HTMLElement>('.chats-list .chat-row')]
        const byTitle = (title: string): HTMLElement | undefined =>
          rows.find((r) => r.querySelector('.chat-title')?.textContent === title)
        const open = byTitle(openTitle)?.querySelector('.chat-pr-status')
        const merged = byTitle(mergedTitle)?.querySelector('.chat-pr-status')
        const plain = byTitle(plainTitle)?.querySelector('.chat-pr-status')
        return {
          openText: open?.textContent ?? null,
          openKind: open?.className.includes('is-open') ?? false,
          mergedText: merged?.textContent ?? null,
          mergedKind: merged?.className.includes('is-merged') ?? false,
          plainHasChip: Boolean(plain),
        }
      },
      openThreadTitle,
      mergedThreadTitle,
      plainThreadTitle,
    )

    await expect(labels.openText).toBe('#42')
    await expect(labels.openKind).toBe(true)
    await expect(labels.mergedText).toBe('merged')
    await expect(labels.mergedKind).toBe(true)
    await expect(labels.plainHasChip).toBe(false)

    await saveElementScreenshot('#pane-projects', 'thread-pr-status-chips.png')
  })
})
