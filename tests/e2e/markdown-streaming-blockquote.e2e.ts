import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedStreamingMarkdownFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('markdown streaming blockquote pending', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedStreamingMarkdownFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders pending blockquotes without raw > markers', async () => {
    await $('[data-message-id="streaming-markdown-message"] .message-text').waitForDisplayed({
      timeout: 30_000,
    })

    const result = await browser.execute(() => {
      const text = document.querySelector(
        '[data-message-id="streaming-markdown-message"] .message-text',
      )
      if (!text) return { error: 'no visible assistant message' }
      text.classList.add('streaming-markdown', 'is-streaming')
      text.innerHTML = [
        '<div class="stream-complete">',
        '<p>Intro paragraph.</p>',
        '<blockquote class="stream-pending stream-pending-blockquote stream-pending-block"><p>Quoted guidance for the team.</p></blockquote>',
        '</div>',
      ].join('')

      const quote = text.querySelector('blockquote.stream-pending-blockquote')
      const styles = quote ? getComputedStyle(quote) : null
      return {
        quoteText: quote?.textContent ?? '',
        hasRawMarker: (quote?.textContent ?? '').trimStart().startsWith('>'),
        borderLeftWidth: styles?.borderLeftWidth ?? '',
        background: styles?.backgroundColor ?? '',
        radius: styles?.borderTopLeftRadius ?? '',
        tagName: quote?.tagName ?? null,
      }
    })

    expect(result).not.toHaveProperty('error')
    expect(result.tagName).toBe('BLOCKQUOTE')
    expect(result.quoteText).toContain('Quoted guidance for the team.')
    expect(result.hasRawMarker).toBe(false)
    // A pending quote has to pick up the committed quote's surface, or it will
    // restyle under the reader as it commits. That surface is a plate now, not a
    // rail, so the plate is what proves the stylesheet reached it.
    expect(result.borderLeftWidth).toBe('0px')
    expect(result.background).not.toBe('rgba(0, 0, 0, 0)')
    expect(Number.parseFloat(result.radius)).toBeGreaterThan(0)

    const quote = $('.stream-pending-blockquote')
    await expect(quote).toBeDisplayed()
    const visible = await browser.execute(() => {
      const element = document.querySelector('.stream-pending-blockquote')
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
    await saveAppScreenshot('markdown-streaming-blockquote-pending.png')
  })
})
