import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedGitSummaryMarkdownFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
const SCREENSHOT_NAME =
  process.env.MARKDOWN_ORDERED_LIST_SCREENSHOT ?? 'markdown-ordered-list-after'
const isBeforeCapture = SCREENSHOT_NAME === 'markdown-ordered-list-before'

describe('markdown ordered list spacing', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedGitSummaryMarkdownFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders git summary as a compact ordered list after tool cards', async () => {
    await $('.tool-card-group .tool-name').waitForExist({ timeout: 30_000 })
    await expect($('.tool-card-group .tool-name')).toHaveText('Git')
    await expect($('.tool-card-group .tool-count')).toHaveText('×2')

    const summary = await $('[data-message-id="msg-assistant-git-summary"] .message-text')
    await summary.waitForExist({ timeout: 30_000 })

    const layout = await browser.execute(() => {
      const root = document.querySelector(
        '[data-message-id="msg-assistant-git-summary"] .message-text',
      )
      if (!root) return { error: 'no summary message-text' }

      const ol = root.querySelector('ol')
      const items = ol ? [...ol.querySelectorAll('li')] : []
      const intro = root.querySelector('p')
      const firstItem = items[0]
      const secondItem = items[1]
      const firstItemCode = firstItem?.querySelector('code')
      const firstItemStrong = firstItem?.querySelector('strong')

      const gap = (a: Element | null | undefined, b: Element | null | undefined) => {
        if (!a || !b) return 0
        return b.getBoundingClientRect().top - a.getBoundingClientRect().bottom
      }

      return {
        olCount: root.querySelectorAll('ol').length,
        liCount: items.length,
        numberedParagraphs: root.querySelectorAll('p').length,
        hasNumberedParagraph: /^\d+\./.test(root.textContent?.trim() ?? ''),
        introToListGap: gap(intro, ol),
        itemGap: gap(firstItem, secondItem),
        firstItemInternalGap: gap(firstItemCode, firstItemStrong),
        firstItemHasCode: !!firstItemCode,
        firstItemHasBold: !!firstItemStrong,
      }
    })

    expect(layout).not.toHaveProperty('error')
    if (!isBeforeCapture) {
      expect(layout.olCount).toBe(1)
      expect(layout.liCount).toBe(3)
      expect(layout.numberedParagraphs).toBe(1)
      expect(layout.hasNumberedParagraph).toBe(false)
      expect(layout.introToListGap).toBeGreaterThan(4)
      expect(layout.itemGap).toBeLessThan(12)
      expect(layout.firstItemInternalGap).toBeGreaterThan(4)
      expect(layout.firstItemHasCode).toBe(true)
      expect(layout.firstItemHasBold).toBe(true)
    }

    await browser.execute(() => {
      const userMsg = document.querySelector('[data-message-id="msg-user-git-summary"]')
      userMsg?.scrollIntoView({ block: 'start' })
    })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, `${SCREENSHOT_NAME}.png`))
  })
})
