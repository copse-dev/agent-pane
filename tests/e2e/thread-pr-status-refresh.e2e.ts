import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedThreadPrStatusFixture } from './helpers/seed-config.ts'

describe('thread Context PR status refresh', () => {
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
    seedThreadPrStatusFixture(process.cwd())
    await browser.reloadSession()
  })

  afterEach(() => {
    resetUserData()
  })

  it('keeps a cached status visible while it refreshes on focus', async function () {
    this.timeout(90_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const pane = $('#pane-files')
    if (!(await pane.isDisplayed())) {
      await $('[aria-label="Toggle right panel"]').click()
      await pane.waitForDisplayed({ timeout: 10_000 })
    }
    if (!(await $('.thread-context').isDisplayed()))
      await $('[aria-label="Open thread context"]').click()
    const open = $('[data-link-group="pr"] .thread-context-pr-status.is-open')
    await open.waitForExist({ timeout: 15_000 })

    const refreshing = await browser.execute(() => {
      const originalNow = Date.now
      Date.now = () => originalNow() + 60_001
      try {
        window.dispatchEvent(new Event('focus'))
        const icon = document.querySelector('[data-link-group="pr"] .thread-context-pr-status')
        return {
          exists: icon !== null,
          open: icon?.classList.contains('is-open') ?? false,
          label: icon?.getAttribute('aria-label') ?? null,
        }
      } finally {
        Date.now = originalNow
      }
    })

    expect(refreshing.exists).toBe(true)
    expect(refreshing.open).toBe(true)
    expect(refreshing.label).toMatch(/#42.*open/i)
    await saveElementScreenshot('#pane-files', 'thread-pr-context-refresh.png')
  })
})
