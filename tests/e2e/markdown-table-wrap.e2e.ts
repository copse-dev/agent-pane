import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedMarkdownTableWrapFixture } from './helpers/seed-config.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { saveChatPaneScreenshot } from './helpers/screenshot.ts'

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
    await $('.message-text table').waitForExist({ timeout: 30_000 })

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
      const statusHeader = table.querySelector('th:last-child')?.getBoundingClientRect()
      const paneBox = table.closest('.pane-chat')?.getBoundingClientRect()
      return {
        rowMetrics,
        tableWidth: tableBox.width,
        messageWidth: messageBox?.width ?? 0,
        tableScrollWidth: table.scrollWidth,
        tableClientWidth: table.clientWidth,
        statusHeaderRight: statusHeader?.right ?? 0,
        paneRight: paneBox?.right ?? 0,
      }
    })

    expect(metrics).not.toHaveProperty('error')
    expect(metrics.rowMetrics).toHaveLength(3)
    expect(metrics.tableWidth).toBeLessThanOrEqual(metrics.messageWidth + 1)
    expect(metrics.tableScrollWidth).toBeLessThanOrEqual(metrics.tableClientWidth + 1)
    expect(metrics.statusHeaderRight).toBeLessThanOrEqual(metrics.paneRight + 1)

    for (const row of metrics.rowMetrics) {
      expect(row.indexSingleLine).toBe(true)
      expect(row.statusSingleLine).toBe(true)
      expect(row.statusText).toBe('DRAFT')
    }

    await assertNoErrorToasts('markdown table wrap fixture')

    const narrowWrap = await browser.execute(() => {
      const app = document.getElementById('app')
      if (!app) return { error: 'no app' }
      app.style.width = '720px'
      window.dispatchEvent(new Event('resize'))
      const branchCode = document.querySelector('.message-text td:nth-child(3) code')
      if (!branchCode) return { error: 'no branch code' }
      const range = document.createRange()
      range.selectNodeContents(branchCode)
      return { branchLineCount: range.getClientRects().length }
    })
    expect(narrowWrap).not.toHaveProperty('error')
    expect(narrowWrap.branchLineCount).toBeGreaterThan(1)

    await saveChatPaneScreenshot('markdown-table-wrap.png')
    await saveChatPaneScreenshot('markdown-table-wrap-message.png')

    const shotMetrics = await browser.execute(() => {
      const table = document.querySelector('.message-text table')
      const projects = document.getElementById('pane-projects')
      const statusHeader = table?.querySelector('th:last-child')
      const branchCode = table?.querySelector('td:nth-child(3) code')
      if (!table || !statusHeader || !branchCode) return { error: 'missing nodes' }
      const statusRect = statusHeader.getBoundingClientRect()
      const appRect = document.getElementById('app')?.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(branchCode)
      return {
        projectsHidden: projects?.hasAttribute('hidden') ?? false,
        statusHeaderText: statusHeader.textContent,
        statusRight: statusRect.right,
        appRight: appRect?.right ?? 0,
        branchLineCount: range.getClientRects().length,
        branchWhiteSpace: getComputedStyle(branchCode).whiteSpace,
      }
    })

    expect(shotMetrics).not.toHaveProperty('error')
    expect(shotMetrics.projectsHidden).toBe(true)
    expect(shotMetrics.statusHeaderText).toBe('Status')
    expect(shotMetrics.statusRight).toBeLessThanOrEqual(shotMetrics.appRight + 1)
    expect(shotMetrics.branchWhiteSpace).toBe('normal')
  })
})
