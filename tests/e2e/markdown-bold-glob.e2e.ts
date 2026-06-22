import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedMarkdownBoldGlobFixture } from './helpers/seed-config.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('markdown bold after glob table cells', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedMarkdownBoldGlobFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders architecture list labels bold after table with glob paths', async () => {
    await $('.message-text h4').waitForExist({ timeout: 15_000 })

    const metrics = await browser.execute(() => {
      const root = document.querySelector('.message-text')
      if (!root) return { error: 'no message-text' }

      const mcpItem = [...root.querySelectorAll('li')].find((li) =>
        li.textContent?.includes('MCP host'),
      )
      const mcpStrong = mcpItem?.querySelector('strong')
      const globCell = root.querySelector('td strong code')
      const supportingHeading = [...root.querySelectorAll('h4')].find((h) =>
        h.textContent?.includes('Key Supporting Files'),
      )
      const supportingList = supportingHeading?.nextElementSibling
      const supportingItems = supportingList ? [...supportingList.querySelectorAll('li')] : []

      const gap = (a: Element | null | undefined, b: Element | null | undefined) => {
        if (!a || !b) return 0
        return b.getBoundingClientRect().top - a.getBoundingClientRect().bottom
      }

      return {
        mcpItemHtml: mcpItem?.innerHTML ?? '',
        mcpStrongText: mcpStrong?.textContent ?? '',
        hasLiteralMcpStars: (mcpItem?.textContent ?? '').includes('**'),
        hasMalformedStrong: (root.innerHTML ?? '').includes('</strong>MCP host**'),
        globCellText: globCell?.textContent ?? '',
        architectureListLabels: [...(root.querySelectorAll('h4') ?? [])]
          .filter((h) => h.textContent?.includes('Architecture Notes'))[0]
          ?.nextElementSibling?.querySelectorAll('li strong').length,
        supportingListItemCount: supportingItems.length,
        supportingItemGap: gap(supportingItems[0], supportingItems[1]),
      }
    })

    expect(metrics).not.toHaveProperty('error')
    expect(metrics.mcpStrongText).toBe('MCP host')
    expect(metrics.hasLiteralMcpStars).toBe(false)
    expect(metrics.hasMalformedStrong).toBe(false)
    expect(metrics.globCellText).toBe('src/**/*.test.ts')
    expect(metrics.architectureListLabels).toBe(5)
    expect(metrics.supportingListItemCount).toBe(3)
    expect(metrics.supportingItemGap).toBeLessThan(12)

    await assertNoErrorToasts('markdown bold glob fixture')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'markdown-bold-glob-full.png'))

    await browser.execute(() => {
      const heading = [...document.querySelectorAll('.message-text h4')].find((h) =>
        h.textContent?.includes('Architecture Notes'),
      )
      heading?.scrollIntoView({ block: 'start' })
    })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'markdown-bold-glob-architecture.png'))
  })
})
