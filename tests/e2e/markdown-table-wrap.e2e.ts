import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedMarkdownTableWrapFixture } from './helpers/seed-config.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

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
        const branchCode = cells[2]?.querySelector('code')

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
          branchSingleLine: branchCode ? singleLine(branchCode) : false,
        }
      })

      const tableStyle = getComputedStyle(table)
      return {
        rowMetrics,
        tableMinWidth: tableStyle.minWidth,
        tableOverflowX: tableStyle.overflowX,
      }
    })

    expect(metrics).not.toHaveProperty('error')
    expect(metrics.tableMinWidth).toBe('max-content')
    expect(metrics.tableOverflowX).toBe('auto')
    expect(metrics.rowMetrics).toHaveLength(3)

    for (const row of metrics.rowMetrics) {
      expect(row.indexSingleLine).toBe(true)
      expect(row.statusSingleLine).toBe(true)
      expect(row.branchSingleLine).toBe(true)
      expect(row.statusText).toBe('DRAFT')
    }

    await assertNoErrorToasts('markdown table wrap fixture')
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'markdown-table-wrap.png'))
  })
})
