import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { approveUnsandboxedTerminalIfPrompted } from './helpers/terminal-approval.ts'

const PROJECT_ID = 'e2e-approval-chat-scope'
const TERMINAL_MARKER = 'approval-terminal-stays-live'

async function xtermText(): Promise<string> {
  return browser.execute(() => document.querySelector('.xterm-rows')?.textContent ?? '')
}

describe('chat-scoped approval', () => {
  before(async function () {
    this.timeout(90_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('covers only chat and leaves the terminal interactive', async function () {
    this.timeout(90_000)

    await $('.titlebar-btn[aria-label="Open terminal"]').click()
    await approveUnsandboxedTerminalIfPrompted()
    await $('.terminal-container .xterm').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(async () => (await xtermText()).length > 0, {
      timeout: 20_000,
      timeoutMsg: 'expected the integrated terminal prompt to become ready',
    })
    const terminalInput = $('.xterm-helper-textarea')
    await terminalInput.click()
    await browser.keys(['clear', '\uE007'])

    await setComposerValue('[[mcp:run_shell {"command":"npm install"}]]')
    await $('.submit-btn').click()

    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Run package install?')

    const scope = await browser.execute(() => {
      const approval = document.querySelector<HTMLDialogElement>('#approval-dialog')
      const chat = document.querySelector<HTMLElement>('#pane-chat')
      const terminal = document.querySelector<HTMLElement>('.terminal-container')
      const scrim = document.querySelector<HTMLElement>('.approval-chat-scrim')
      if (!approval || !chat || !terminal || !scrim) return null
      const approvalRect = approval.getBoundingClientRect()
      const chatRect = chat.getBoundingClientRect()
      return {
        parentId: approval.parentElement?.id ?? null,
        isModal: approval.matches(':modal'),
        scrimVisible: !scrim.hidden,
        containedHorizontally:
          approvalRect.left >= chatRect.left && approvalRect.right <= chatRect.right,
        containedVertically:
          approvalRect.top >= chatRect.top && approvalRect.bottom <= chatRect.bottom,
        terminalInert: terminal.closest('[inert]') !== null,
      }
    })
    assert.deepEqual(scope, {
      parentId: 'pane-chat',
      isModal: false,
      scrimVisible: true,
      containedHorizontally: true,
      containedVertically: true,
      terminalInert: false,
    })

    await terminalInput.click()
    await browser.keys(['echo', ' ', TERMINAL_MARKER, '\uE007'])
    await browser.waitUntil(async () => (await xtermText()).includes(TERMINAL_MARKER), {
      timeout: 30_000,
      timeoutMsg: 'expected the terminal to accept input while approval remained open',
    })
    await expect(dialog).toBeDisplayed()
    await browser.keys('\uE003')

    await saveAppScreenshot('approval-chat-scoped.png')
    await dialog.$('.approval-reject').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
  })
})
