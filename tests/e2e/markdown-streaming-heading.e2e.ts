import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedStreamingMarkdownFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('markdown streaming heading pending', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedStreamingMarkdownFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders pending ### headings without raw hash markers', async () => {
    await $('[data-message-id="streaming-markdown-message"] .message-text').waitForDisplayed({
      timeout: 30_000,
    })

    const result = await browser.execute(() => {
      const text = document.querySelector(
        '[data-message-id="streaming-markdown-message"] .message-text',
      )
      if (!text) throw new Error('no visible assistant message')
      text.classList.add('streaming-markdown', 'is-streaming')
      text.innerHTML = [
        '<div class="stream-complete">',
        '<h2>Summary</h2>',
        '<div class="stream-pending stream-pending-heading stream-pending-h3 stream-pending-block" data-heading-level="3">Architecture Highlights</div>',
        '</div>',
      ].join('')

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

    await expect($('.stream-pending')).toBeDisplayed()
    const visible = await browser.execute(() => {
      const element = document.querySelector('.stream-pending')
      if (!element) return false
      const rect = element.getBoundingClientRect()
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top >= 0 &&
        rect.bottom <= innerHeight &&
        element.contains(
          document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
        )
      )
    })
    expect(visible).toBe(true)
    await saveAppScreenshot('markdown-streaming-heading-pending.png')
  })
})
