import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('markdown streaming table pending rows', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-streaming-table-project', { subagentsEnabled: false })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders a streaming table body row as tr.stream-pending-row, not raw pipe text', async () => {
    await $('.messages-list').waitForExist({ timeout: 30_000 })

    const result = await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      if (!list) return { error: 'no messages list' }

      const msg = document.createElement('div')
      msg.className = 'msg msg-assistant'
      const text = document.createElement('div')
      text.className = 'message-text streaming-markdown is-streaming'
      text.innerHTML = [
        '<div class="stream-complete">',
        '<table>',
        '<thead><tr><th>Path</th><th>Role</th></tr></thead>',
        '<tbody>',
        '<tr><td><code>src/</code></td><td>Application source</td></tr>',
        '<tr class="stream-pending-row"><td><code>tests/e2e/</code></td><td>WebdriverIO specs</td></tr>',
        '</tbody>',
        '</table>',
        '</div>',
      ].join('')
      msg.append(text)
      list.append(msg)

      const pendingRow = text.querySelector('tr.stream-pending-row')
      const rawPending = text.querySelector('span.stream-pending')
      return {
        pendingRowText: pendingRow?.textContent ?? '',
        hasRawPendingSpan: !!rawPending,
        cellCount: pendingRow?.querySelectorAll('td').length ?? 0,
        pendingInsideTable: pendingRow?.closest('table') !== null,
      }
    })

    expect(result).not.toHaveProperty('error')
    expect(result.hasRawPendingSpan).toBe(false)
    expect(result.pendingInsideTable).toBe(true)
    expect(result.cellCount).toBe(2)
    expect(result.pendingRowText).toContain('tests/e2e/')
    expect(result.pendingRowText).toContain('WebdriverIO specs')

    await saveAppScreenshot('markdown-streaming-table-pending-row.png')
  })
})
