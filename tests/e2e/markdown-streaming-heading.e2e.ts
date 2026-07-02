import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('markdown streaming heading pending', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-streaming-heading-project', { subagentsEnabled: false })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders pending ### headings without raw hash markers', async () => {
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
        '<h2>Summary</h2>',
        '<div class="stream-pending stream-pending-heading stream-pending-h3 stream-pending-block" data-heading-level="3">Architecture Highlights</div>',
        '</div>',
      ].join('')
      msg.append(text)
      list.append(msg)

      const heading = text.querySelector('.stream-pending-heading')
      return {
        headingText: heading?.textContent ?? '',
        headingLevel: heading?.getAttribute('data-heading-level') ?? null,
        hasRawHashes: (heading?.textContent ?? '').includes('#'),
        innerHTML: text.innerHTML,
      }
    })

    expect(result).not.toHaveProperty('error')
    expect(result.headingText).toBe('Architecture Highlights')
    expect(result.headingLevel).toBe('3')
    expect(result.hasRawHashes).toBe(false)

    await saveAppScreenshot('markdown-streaming-heading-pending.png')
  })
})
