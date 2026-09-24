import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedThreadPrStatusFixture } from './helpers/seed-config.ts'

describe('thread GitHub PR status refresh', () => {
  let openThreadTitle: string

  before(() => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
  })

  beforeEach(async function () {
    this.timeout(120_000)
    writeE2eEnv({
      COPSE_PANEL_MOCK_LLM: '1',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      COPSE_PANEL_MOCK_GH: '1',
      COPSE_PANEL_MOCK_GH_STATUS: 'ready',
    })
    resetUserData()
    ;({ openThreadTitle } = seedThreadPrStatusFixture(process.cwd()))
    await browser.reloadSession()
  })

  afterEach(() => {
    resetUserData()
  })

  it('keeps the current PR icon visible while expired status refreshes', async function () {
    this.timeout(90_000)

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await expect($('.chat-row.selected .chat-title')).toHaveText(openThreadTitle)

    const openIcon = await $('.chat-row.selected .chat-pr-status')
    await openIcon.waitForExist({ timeout: 15_000 })
    await expect(openIcon).toHaveElementClass('is-open')

    const refreshing = await browser.execute(() => {
      const originalNow = Date.now
      const expiredAt = originalNow() + 60_001
      Date.now = () => expiredAt
      try {
        const searchInput = document.querySelector<HTMLInputElement>('.projects-search-input')
        searchInput?.dispatchEvent(new Event('input', { bubbles: true }))
        const icon = document.querySelector('.chat-row.selected .chat-pr-status')
        return {
          exists: icon !== null,
          open: icon?.classList.contains('is-open') ?? false,
          label: icon?.getAttribute('aria-label') ?? null,
        }
      } finally {
        Date.now = originalNow
      }
    })

    await expect(refreshing.exists).toBe(true)
    await expect(refreshing.open).toBe(true)
    await expect(refreshing.label).toMatch(/#42.*open/i)
    await saveElementScreenshot('#pane-projects', 'thread-pr-status-refresh.png')
  })
})
