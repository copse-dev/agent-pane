import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

// Visual eval for #515: the ask_user tool blocks the agent loop on a modal dialog
// until the user answers. Component tests cover DOM behaviour; this spec exercises
// the full Electron path (mock directive → tool → IPC → dialog → respond).
describe('ask_user dialog', () => {
  before(async () => {
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
      '[[mcp:ask_user {"questions":[{"question":"Claude is not signed in. Run `claude /login` in a terminal, then re-send your message.","options":["Run `claude /login`","Not now"]}]}]]',
    )
    await $('.submit-btn').click()

    const dialog = await $('#ask-user-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })

    await expect(dialog.$('.ask-user-question code')).toHaveText('claude /login')
    await expect(dialog.$('.ask-user-question')).not.toHaveText(expect.stringContaining('`'))

    const option = await dialog.$('.ask-user-option*=Run')
    await expect(option.$('code')).toHaveText('claude /login')
    await saveElementScreenshot('#ask-user-dialog', 'ask-user-dialog.png')
    await option.click()

    const input = await dialog.$('.ask-user-input')
    await expect(input).toHaveValue('Run claude /login')

    await dialog.$('.ask-user-submit').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })

    // Tool finished — the mock turn completes and an assistant message appears.
    await browser.waitUntil(async () => (await $$('.msg.msg-assistant')).length >= 1, {
      timeout: 30_000,
      timeoutMsg: 'expected assistant reply after ask_user answer',
    })
  })
})
