import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'

// Composing ~140K tokens of draft against the 128K window of the smallest model
// in the catalog. Under `COPSE_PANEL_MOCK_LLM=1` every non-catalog model resolves
// to a 128K window (resolve-context-window.ts), so a catalog model is the only
// way to pin a real window in e2e — and 4 chars/token means the draft has to be
// genuinely large rather than merely long.
const OVERSIZED_DRAFT_REPEATS = 21_000

describe('composer context-window warning', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-context-fit-project', {
      subagentsEnabled: false,
      model: 'gpt-4o-mini',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('explains an overflowing thread and opens the model picker', async () => {
    await $('.prompt-input').waitForDisplayed({ timeout: 30_000 })

    // Built in the renderer rather than passed in: a half-megabyte argument over
    // the WDIO bridge is far slower than repeating a short string in place.
    await browser.execute((repeats: number) => {
      const composer = document.querySelector('.prompt-input')
      if (!(composer instanceof HTMLElement)) throw new Error('.prompt-input not found')
      composer.textContent = 'lorem ipsum dolor sit amet '.repeat(repeats)
      composer.dispatchEvent(new Event('input', { bubbles: true }))
    }, OVERSIZED_DRAFT_REPEATS)

    const warning = await $('.composer-context-warning')
    await expect(warning).toBeDisplayed({ wait: 30_000 })
    const text = await warning.$('.composer-context-warning-text')
    await expect(text).toHaveText(/This thread no longer fits “GPT-4o mini”/)
    await expect(text).toHaveText(/context window holds 128K/)
    await expect(text).toHaveText(/Pick a model with a larger context window/)

    await saveElementScreenshot('.composer-context-warning', 'composer-context-warning-over.png')
    // Placement is the point of the change: the advice sits with the composer and
    // its model picker, not in app-level chrome.
    await saveAppScreenshot('composer-context-warning-app.png')

    // The advice names the picker, so the action has to reach it.
    await $('.composer-context-model-btn').click()
    await expect($('.model-picker-menu')).toBeDisplayed()
  })
})
