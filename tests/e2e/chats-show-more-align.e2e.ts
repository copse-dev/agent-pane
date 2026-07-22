import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
const PROJECT_ID = 'e2e-show-more-align-project'
/** One past the default sidebar page so `.chats-show-more` appears. */
const THREAD_COUNT = 11

function seedManyThreads(): void {
  const now = Date.now()
  // Each thread needs a message — empty idle threads are blank and get pruned
  // down to one on load (`isBlankThread` / openNewThread helpers).
  const threads = Array.from({ length: THREAD_COUNT }, (_, i) => {
    const n = i + 1
    const id = `thread-${String(n).padStart(2, '0')}`
    return {
      id,
      title: `Thread ${String(n).padStart(2, '0')}`,
      status: 'idle',
      messages: [
        {
          id: `msg-${id}`,
          role: 'user',
          content: `Seed message for ${id}`,
          toolCalls: [],
          createdAt: now - n * 1_000,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: now - n * 1_000,
      updatedAt: now - n * 1_000,
    }
  })
  writeSeedConfig({
    projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
    activeProjectId: PROJECT_ID,
    activeThreadId: 'thread-01',
    [`threads:${PROJECT_ID}`]: threads,
  })
}

describe('sidebar Show more alignment', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedManyThreads()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('aligns Show more text with thread titles above it', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const showMore = await $('.chats-show-more')
    await showMore.waitForDisplayed({ timeout: 10_000 })
    await expect(showMore).toHaveText('Show more')

    const alignment = await browser.execute(() => {
      const row = document.querySelector<HTMLElement>('.chats-list .chat-row')
      const btn = document.querySelector<HTMLElement>('.chats-show-more')
      if (!row || !btn) return null
      const rowStyle = getComputedStyle(row)
      const btnStyle = getComputedStyle(btn)
      const rowTextLeft = row.getBoundingClientRect().left + parseFloat(rowStyle.paddingLeft)
      const btnTextLeft = btn.getBoundingClientRect().left + parseFloat(btnStyle.paddingLeft)
      return {
        rowTextLeft,
        btnTextLeft,
        rowMarginInline: rowStyle.marginLeft,
        btnMarginInline: btnStyle.marginLeft,
      }
    })

    expect(alignment).not.toBeNull()
    expect(alignment!.btnMarginInline).toBe(alignment!.rowMarginInline)
    expect(Math.abs(alignment!.btnTextLeft - alignment!.rowTextLeft)).toBeLessThanOrEqual(0.5)

    await saveElementScreenshot('.chats-list', 'chats-show-more-align.png')
  })
})
