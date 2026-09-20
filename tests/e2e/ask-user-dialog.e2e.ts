import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

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

  it('dismisses the modal when the originating run is stopped', async () => {
    await setComposerValue(
      '[[mcp:ask_user {"questions":[{"question":"Should this run keep waiting?"}]}]]',
    )
    await $('.submit-btn').click()

    const dialog = await $('#ask-user-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(async () => await $('.stop-btn').isDisplayed(), {
      timeout: 10_000,
      timeoutMsg: 'expected Stop while ask_user blocks the run',
    })

    await browser.execute(async () => {
      const [threadId] = await window.api.agent.runningThreadIds()
      if (!threadId) throw new Error('expected a running ask_user thread')
      await window.api.agent.abort(threadId)
    })

    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    await expect(dialog).not.toBeDisplayed()
    await saveAppScreenshot('ask-user-dialog-cancelled.png')
  })

  it('submits an answer with the Cmd/Ctrl+Enter keyboard shortcut', async () => {
    await setComposerValue(
      '[[mcp:ask_user {"questions":[{"question":"What is your favorite color?"}]}]]',
    )
    await $('.submit-btn').click()

    const dialog = await $('#ask-user-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })

    const input = await dialog.$('.ask-user-input')
    await input.click()
    await input.setValue('Green')
    await saveElementScreenshot('#ask-user-dialog', 'ask-user-dialog-keyboard-submit.png')

    // Ctrl+Enter submits regardless of platform — the handler accepts either
    // Cmd or Ctrl, and Linux CI has no Meta key to press.
    await browser.keys(['Control', 'Enter'])

    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    await expect(dialog).not.toBeDisplayed()

    // Tool finished — the mock turn completes and an assistant message appears.
    await browser.waitUntil(async () => (await $$('.msg.msg-assistant')).length >= 1, {
      timeout: 30_000,
      timeoutMsg: 'expected assistant reply after ask_user keyboard answer',
    })
  })
})
