import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedMarkdownTableCodeFirstColumnFixture } from './helpers/seed-config.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'

describe('markdown table with a code-span first column', () => {
  before(async () => {
    resetUserData()
    seedMarkdownTableCodeFirstColumnFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('keeps the first-column code id on one line instead of one char per line', async () => {
    await $('.message-text table').waitForExist({ timeout: 30_000 })

    const metrics = await browser.execute(() => {
      const table = document.querySelector('.message-text table')
      if (!table) return { error: 'no table' }

      const firstCells = [...table.querySelectorAll('tbody tr')].map((row) => {
        const code = row.querySelector('td:first-child code')
        if (!code) return null
        const range = document.createRange()
        range.selectNodeContents(code)
        const rects = [...range.getClientRects()]
        const box = code.getBoundingClientRect()
        return {
          text: code.textContent ?? '',
          lineCount: rects.length,
          whiteSpace: getComputedStyle(code).whiteSpace,
          width: box.width,
        }
      })

      return { firstCells }
    })

    expect(metrics).not.toHaveProperty('error')
    expect(metrics.firstCells).toHaveLength(3)

    for (const cell of metrics.firstCells) {
      expect(cell).not.toBeNull()
      if (!cell) continue
      // The whole id must render on a single line — no per-character shattering.
      expect(cell.lineCount).toBe(1)
      expect(cell.whiteSpace).toBe('nowrap')
      // A column wide enough for the id is far wider than the ~2ch the bug produced.
      expect(cell.width).toBeGreaterThan(40)
    }

    await assertNoErrorToasts('markdown table code-first-column fixture')
  })
})
