import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedSprintRetroNbspFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('markdown nbsp metadata rendering', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedSprintRetroNbspFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders sprint metadata nbsp entities as spaces, not literal text', async () => {
    await $('.messages-list').waitForExist({ timeout: 30_000 })
    await $('.message-text').waitForExist({ timeout: 30_000 })

    const result = await browser.execute(() => {
      const textEl = document.querySelector('.message-text')
      if (!textEl) return { error: 'no message text' }
      const text = textEl.textContent ?? ''
      const html = textEl.innerHTML
      return {
        text,
        hasLiteralNbsp: /&nbsp;/.test(text),
        hasDoubleEncoded: /&amp;nbsp;/.test(html),
        hasSprintDates: text.includes('Sprint Dates:'),
        hasTeam: text.includes('Platform Squad'),
      }
    })

    expect(result).not.toHaveProperty('error')
    expect(result.hasLiteralNbsp).toBe(false)
    expect(result.hasDoubleEncoded).toBe(false)
    expect(result.hasSprintDates).toBe(true)
    expect(result.hasTeam).toBe(true)
    expect(result.text).toMatch(/2025-01-13[\s\u00A0]+→/)

    await saveAppScreenshot('markdown-sprint-retro-nbsp.png')
  })
})
