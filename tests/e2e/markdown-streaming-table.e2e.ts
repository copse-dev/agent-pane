import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('markdown streaming table transitions', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-streaming-table-project', { subagentsEnabled: false })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('applies subtle enter animations while a table is streaming in', async () => {
    await $('.messages-list').waitForExist({ timeout: 15_000 })

    const layout = await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      if (!list) return { error: 'no messages list' }

      const msg = document.createElement('div')
      msg.className = 'msg msg-assistant'
      const text = document.createElement('div')
      text.className = 'message-text is-streaming'
      text.innerHTML = [
        '<div class="stream-complete">',
        '<table class="stream-enter">',
        '<thead><tr><th>Path</th><th>Role</th></tr></thead>',
        '<tbody>',
        '<tr class="stream-enter"><td><code>src/</code></td><td>Application source</td></tr>',
        '</tbody>',
        '</table>',
        '</div>',
        '<span class="stream-pending">| <code>tests/e2e/</code> | WebdriverIO specs |</span>',
      ].join('')
      msg.append(text)
      list.append(msg)

      const table = text.querySelector('table.stream-enter')
      const row = text.querySelector('tbody tr.stream-enter')
      const pending = text.querySelector('.stream-pending')
      const tableAnim = table ? getComputedStyle(table).animationName : 'none'
      const rowAnim = row ? getComputedStyle(row.querySelector('td')!).animationName : 'none'

      return {
        isStreaming: text.classList.contains('is-streaming'),
        hasStreamComplete: !!text.querySelector('.stream-complete'),
        pendingText: pending?.textContent ?? '',
        tableAnim,
        rowAnim,
      }
    })

    expect(layout).not.toHaveProperty('error')
    expect(layout.isStreaming).toBe(true)
    expect(layout.hasStreamComplete).toBe(true)
    expect(layout.pendingText).toContain('tests/e2e/')
    expect(layout.tableAnim).not.toBe('none')
    expect(layout.rowAnim).not.toBe('none')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'markdown-streaming-table-mid.png'))
  })
})
