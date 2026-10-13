import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('markdown streaming blockquote pending', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-streaming-blockquote-project', { subagentsEnabled: false })
    // A persisted user message keeps the real conversation visible. An empty
    // thread hides it for the Activity idle composer, even if DOM text exists.
    writeSeedConfig({
      projects: [
        { id: 'e2e-streaming-blockquote-project', path: process.cwd(), name: 'workspace' },
      ],
      activeProjectId: 'e2e-streaming-blockquote-project',
      expandedProjectId: 'e2e-streaming-blockquote-project',
      activeThreadId: 'streaming-blockquote-thread',
      'threads:e2e-streaming-blockquote-project': [
        {
          id: 'streaming-blockquote-thread',
          title: 'Streaming blockquote',
          status: 'idle',
          createdAt: Date.UTC(2026, 6, 17, 9),
          updatedAt: Date.UTC(2026, 6, 17, 9),
          messages: [
            {
              id: 'streaming-prompt',
              role: 'user',
              content: 'Show the streaming blockquote state.',
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders pending blockquotes without raw > markers', async () => {
    await $('.messages-list').waitForDisplayed({ timeout: 30_000 })
    await expect($('.msg-user .message-text')).toHaveText('Show the streaming blockquote state.')

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

    const visibleState = $('.stream-pending-blockquote')
    await visibleState.waitForDisplayed({ timeout: 5_000 })
    await expect(visibleState).toHaveText(expect.stringContaining('Quoted guidance for the team.'))
    const bounds = await visibleState.getSize()
    expect(bounds.width).toBeGreaterThan(0)
    expect(bounds.height).toBeGreaterThan(0)
    await saveAppScreenshot('markdown-streaming-blockquote-pending.png')
  })
})
