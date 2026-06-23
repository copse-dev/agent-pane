import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedMarkdownTableWrapFixture } from './helpers/seed-config.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

describe('markdown table wrapping', () => {
  before(async () => {
    resetUserData()
    seedMarkdownTableWrapFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('keeps index and status cells on one line in a PR-style table', async () => {
    await $('.message-text table').waitForExist({ timeout: 15_000 })

    const metrics = await browser.execute(() => {
      const table = document.querySelector('.message-text table')
      if (!table) return { error: 'no table' }

      const rows = [...table.querySelectorAll('tbody tr')]
      const rowMetrics = rows.map((row) => {
        const cells = [...row.querySelectorAll('td')]
        const indexCell = cells[0]
        const statusCell = cells[3]

        const singleLine = (el: Element | undefined) => {
          if (!el) return false
          const range = document.createRange()
          range.selectNodeContents(el)
          const rects = [...range.getClientRects()]
          return rects.length <= 1
        }

        return {
          indexText: indexCell?.textContent ?? '',
          statusText: statusCell?.textContent ?? '',
          indexSingleLine: singleLine(indexCell ?? undefined),
          statusSingleLine: singleLine(statusCell ?? undefined),
        }
      })

      const tableStyle = getComputedStyle(table)
      const tableBox = table.getBoundingClientRect()
      const messageBox = table.closest('.message-text')?.getBoundingClientRect()
      return {
        rowMetrics,
        tableWidth: tableBox.width,
        messageWidth: messageBox?.width ?? 0,
        tableScrollWidth: table.scrollWidth,
        tableClientWidth: table.clientWidth,
      }
    })

    expect(metrics).not.toHaveProperty('error')
    expect(metrics.rowMetrics).toHaveLength(3)
    expect(metrics.tableWidth).toBeLessThanOrEqual(metrics.messageWidth + 1)
    expect(metrics.tableScrollWidth).toBeLessThanOrEqual(metrics.tableClientWidth + 1)

    for (const row of metrics.rowMetrics) {
      expect(row.indexSingleLine).toBe(true)
      expect(row.statusSingleLine).toBe(true)
      expect(row.statusText).toBe('DRAFT')
    }

    await assertNoErrorToasts('markdown table wrap fixture')

    await browser.execute(() => {
      document.querySelector('.message-text table')?.scrollIntoView({ block: 'center' })
    })
    await saveAppScreenshot('markdown-table-wrap.png')
    await saveElementScreenshot('.message-text table', 'markdown-table-wrap-table.png')
  })
})
