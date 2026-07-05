import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('markdown streaming blockquote pending', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-streaming-blockquote-project', { subagentsEnabled: false })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders pending blockquotes without raw > markers', async () => {
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
        '<p>Intro paragraph.</p>',
        '<blockquote class="stream-pending stream-pending-blockquote stream-pending-block"><p>Quoted guidance for the team.</p></blockquote>',
        '</div>',
      ].join('')
      msg.append(text)
      list.append(msg)

      const quote = text.querySelector('blockquote.stream-pending-blockquote')
      const styles = quote ? getComputedStyle(quote) : null
      return {
        quoteText: quote?.textContent ?? '',
        hasRawMarker: (quote?.textContent ?? '').trimStart().startsWith('>'),
        borderLeftWidth: styles?.borderLeftWidth ?? '',
        tagName: quote?.tagName ?? null,
      }
    })

    expect(result).not.toHaveProperty('error')
    expect(result.tagName).toBe('BLOCKQUOTE')
    expect(result.quoteText).toContain('Quoted guidance for the team.')
    expect(result.hasRawMarker).toBe(false)
    expect(result.borderLeftWidth).not.toBe('0px')

    await saveAppScreenshot('markdown-streaming-blockquote-pending.png')
  })
})
