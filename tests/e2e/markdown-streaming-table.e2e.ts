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

  it('keeps in-progress table rows inside the table while streaming', async () => {
    await $('.messages-list').waitForExist({ timeout: 15_000 })

    const layout = await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      if (!list) return { error: 'no messages list' }

      const msg = document.createElement('div')
      msg.className = 'msg msg-assistant'
      const text = document.createElement('div')
      text.className = 'message-text is-streaming'
      text.innerHTML =
        '<div class="stream-complete"></div><span class="stream-pending"></span>'
      msg.append(text)
      list.append(msg)

      const completed = text.querySelector('.stream-complete') as HTMLElement
      completed.innerHTML = [
        '<table>',
        '<thead><tr><th>Path</th><th>Role</th></tr></thead>',
        '<tbody><tr><td>src/</td><td>Application source</td></tr></tbody>',
        '</table>',
      ].join('')

      const tbody = completed.querySelector('tbody')!
      const pendingRow = document.createElement('tr')
      pendingRow.className = 'stream-pending-row'
      pendingRow.innerHTML = '<td>tests/e2e/</td><td>WebdriverIO specs</td>'
      tbody.appendChild(pendingRow)

      const pending = text.querySelector('.stream-pending') as HTMLElement
      pending.hidden = true
      pending.textContent = ''

      const row = text.querySelector('tbody tr.stream-pending-row')
      const rowTransition = row ? getComputedStyle(row).transitionProperty : 'none'

      return {
        pendingHidden: pending.hidden,
        pendingRowInTable: !!completed.querySelector('tr.stream-pending-row'),
        rawPendingBelowTable: text.textContent?.includes('| tests/e2e/ | WebdriverIO specs |'),
        rowTransition,
      }
    })

    expect(layout).not.toHaveProperty('error')
    expect(layout.pendingHidden).toBe(true)
    expect(layout.pendingRowInTable).toBe(true)
    expect(layout.rawPendingBelowTable).toBe(false)
    expect(layout.rowTransition).toContain('transform')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'markdown-streaming-table-mid.png'))
  })
})
