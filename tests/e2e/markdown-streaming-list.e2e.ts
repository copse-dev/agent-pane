import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('markdown streaming list pending', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-streaming-list-project', { subagentsEnabled: false })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders lazy continuations inside the open list item without raw leading dashes', async () => {
    await $('.messages-list').waitForExist({ timeout: 30_000 })

    const result = await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      if (!list) return { error: 'no messages list' }

      const msg = document.createElement('div')
      msg.className = 'msg msg-assistant'
      const text = document.createElement('div')
      text.className = 'message-text is-streaming'
      text.innerHTML = [
        '<div class="stream-complete">',
        '<ul><li>Database migration ran flawlessly<span class="stream-pending stream-pending-list-continuation stream-pending-block">  - zero downtime during production rollout.</span></li></ul>',
        '</div>',
      ].join('')
      msg.append(text)
      list.append(msg)

      const li = text.querySelector('li')
      const continuation = text.querySelector('.stream-pending-list-continuation')
      return {
        liText: li?.textContent ?? '',
        continuationText: continuation?.textContent ?? '',
        hasFakeListItem: !!text.querySelector('.stream-pending-list-item'),
        hasRawDashPrefix: /^- /.test(continuation?.textContent ?? ''),
      }
    })

    expect(result).not.toHaveProperty('error')
    expect(result.hasFakeListItem).toBe(false)
    expect(result.continuationText).toContain('- zero downtime')
    expect(result.liText).toContain('Database migration ran flawlessly')
    expect(result.liText).toContain('zero downtime')

    await saveAppScreenshot('markdown-streaming-list-continuation.png')
  })
})
