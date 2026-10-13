import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('markdown streaming heading pending', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-streaming-heading-project', { subagentsEnabled: false })
    // A persisted user message keeps the real conversation visible. An empty
    // thread hides it for the Activity idle composer, even if DOM text exists.
    writeSeedConfig({
      projects: [{ id: 'e2e-streaming-heading-project', path: process.cwd(), name: 'workspace' }],
      activeProjectId: 'e2e-streaming-heading-project',
      expandedProjectId: 'e2e-streaming-heading-project',
      activeThreadId: 'streaming-heading-thread',
      'threads:e2e-streaming-heading-project': [
        {
          id: 'streaming-heading-thread',
          title: 'Streaming heading',
          status: 'idle',
          createdAt: Date.UTC(2026, 6, 17, 9),
          updatedAt: Date.UTC(2026, 6, 17, 9),
          messages: [
            { id: 'streaming-prompt', role: 'user', content: 'Show the streaming heading state.' },
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

  it('renders pending ### headings without raw hash markers', async () => {
    await $('.messages-list').waitForDisplayed({ timeout: 30_000 })
    await expect($('.msg-user .message-text')).toHaveText('Show the streaming heading state.')

    const result = await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      if (!list) return { error: 'no messages list' }

      const msg = document.createElement('div')
      msg.className = 'msg msg-assistant'
      const text = document.createElement('div')
      text.className = 'message-text streaming-markdown is-streaming'
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

    const visibleState = $('.stream-pending-heading')
    await visibleState.waitForDisplayed({ timeout: 5_000 })
    await expect(visibleState).toHaveText(expect.stringContaining('Architecture Highlights'))
    const bounds = await visibleState.getSize()
    expect(bounds.width).toBeGreaterThan(0)
    expect(bounds.height).toBeGreaterThan(0)
    await saveAppScreenshot('markdown-streaming-heading-pending.png')
  })
})
