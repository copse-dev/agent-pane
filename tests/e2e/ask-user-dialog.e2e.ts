import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Visual eval for #515: the ask_user tool blocks the agent loop on a modal dialog
// until the user answers. Component tests cover DOM behaviour; this spec exercises
// the full Electron path (mock directive → tool → IPC → dialog → respond).
describe('ask_user dialog', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-ask-user-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('shows the modal with options and returns the answer to the agent', async () => {
    await setComposerValue(
      '[[mcp:ask_user {"questions":[{"question":"Which HTTP client should we use?","options":["axios","fetch"]}]}]]',
    )
    await $('.submit-btn').click()

    const dialog = await $('#ask-user-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })

    await expect(dialog.$('.ask-user-question')).toHaveText('Which HTTP client should we use?')

    const option = await dialog.$('.ask-user-option=fetch')
    await option.click()

    const input = await dialog.$('.ask-user-input')
    await expect(input).toHaveValue('fetch')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'ask-user-dialog.png'))

    await dialog.$('.ask-user-submit').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })

    // Tool finished — the mock turn completes and an assistant message appears.
    await browser.waitUntil(async () => (await $$('.msg.msg-assistant')).length >= 1, {
      timeout: 30_000,
      timeoutMsg: 'expected assistant reply after ask_user answer',
    })
  })
})
