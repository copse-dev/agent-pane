import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { e2eWorkspaceDir, resetUserData, seedForkResendFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Visual eval for thread forking + resending the last message. The pure
// transforms and controllers are unit-tested (shared/store/fork-thread.test.ts,
// main/services/thread-fork.test.ts, controller/{fork-thread,resend-message}
// .test.ts) and the DOM shape in views/message-fork-resend.test.ts; this proves
// the affordances render on real prompt bubbles in the running app, that a fork
// lands as a new sidebar thread carrying the conversation up to the fork point,
// and captures screenshots for visual inspection per AGENTS.md.

describe('fork a thread and resend the last message', function () {
  this.timeout(90_000)

  afterEach(() => {
    resetUserData()
  })

  it('gives a whole-thread fork model context when the source has no history sidecar', async function () {
    resetUserData()
    const { projectId } = seedForkResendFixture(process.cwd())
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const sourceRow = await $('.chat-row.selected')
    const sourceThreadId = await sourceRow.getAttribute('data-thread-id')
    await sourceRow.click({ button: 'right' })
    await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
    await $('.context-menu-item*=Fork').click()

    await browser.waitUntil(
      async () => (await $('.chat-row.selected').getAttribute('data-thread-id')) !== sourceThreadId,
      { timeout: 10_000, timeoutMsg: 'expected the whole-thread fork to become active' },
    )
    const forkedThreadId = await $('.chat-row.selected').getAttribute('data-thread-id')
    if (!forkedThreadId) throw new Error('forked thread has no id')
    const historyPath = join(e2eWorkspaceDir(), projectId, forkedThreadId, 'agent-history.json')

    await browser.waitUntil(() => existsSync(historyPath), {
      timeout: 10_000,
      timeoutMsg: 'expected the fork to persist rebuilt provider history',
    })
    const history = JSON.parse(readFileSync(historyPath, 'utf8')) as {
      messages?: Array<{ role?: string; content?: unknown }>
    }
    expect(history.messages?.[0]).toEqual({
      role: 'user',
      content: 'Where does the login redirect get decided?',
    })
    await expect(await $$('.messages-list .msg-user')).toBeElementsArrayOfSize(2)

    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await $('.messages-list').saveScreenshot(
      join(SCREENSHOT_DIR, 'message-fork-resend-whole-thread-context.png'),
    )
  })

  it('offers per-prompt actions, and Fork from here branches the conversation', async function () {
    resetUserData()
    const { title } = seedForkResendFixture(process.cwd())
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(async () => (await $$('.messages-list .msg-user')).length === 2, {
      timeout: 10_000,
      timeoutMsg: 'expected both seeded prompts in the transcript',
    })

    // Every prompt can start a fork; only the latest offers Resend — the older
    // one carries the button hidden, since a resend always repeats the latest.
    await expect(await $$('.messages-list .msg-user .msg-fork')).toBeElementsArrayOfSize(2)
    const firstPrompt = await $('.messages-list .msg-user')
    const latestPrompt = await $$('.messages-list .msg-user')[1]
    await expect(firstPrompt.$('.msg-resend')).toHaveAttribute('hidden')
    await expect(latestPrompt.$('.msg-resend')).not.toHaveAttribute('hidden')

    // The row is a hover affordance (opacity 0 at rest), exactly like the Copy
    // button on an assistant reply — so it only becomes visible on hover.
    await expect(latestPrompt.$('.msg-actions')).not.toBeDisplayed()
    await latestPrompt.moveTo()
    await expect(latestPrompt.$('.msg-actions')).toBeDisplayed()
    await expect(latestPrompt.$('.msg-resend')).toBeDisplayed()

    const actionCenterOffset = await browser.execute(() => {
      const prompts = document.querySelectorAll<HTMLElement>('.messages-list .msg-user')
      const bubble = prompts.item(prompts.length - 1)
      const actions = bubble?.querySelector<HTMLElement>('.msg-actions')
      if (!bubble || !actions) return null
      const bubbleRect = bubble.getBoundingClientRect()
      const actionsRect = actions.getBoundingClientRect()
      return actionsRect.top + actionsRect.height / 2 - (bubbleRect.top + bubbleRect.height / 2)
    })
    assert.ok(actionCenterOffset !== null, 'the latest prompt actions must render')
    assert.ok(
      Math.abs(actionCenterOffset) <= 1,
      `one-line prompt actions must be vertically centred in the bubble, offset ${String(actionCenterOffset)}`,
    )

    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await saveAppScreenshot('message-fork-resend-actions.png')

    // Fork from the FIRST prompt: the new thread carries only that exchange.
    await firstPrompt.moveTo()
    await firstPrompt.$('.msg-fork').click()

    const forkedTitle = `${title} (fork)`
    await browser.waitUntil(
      async () => {
        // wdio's element-array .map is itself async — never wrap it in Promise.all.
        const labels = await $$('.chat-row .chat-title').map((row) => row.getText())
        return labels.includes(forkedTitle)
      },
      { timeout: 10_000, timeoutMsg: 'expected a forked thread row in the sidebar' },
    )

    // The fork is the active thread and carries the conversation up to the fork
    // point — that prompt and nothing after it; the rest stays on the original.
    await browser.waitUntil(async () => (await $$('.messages-list .msg-user')).length === 1, {
      timeout: 10_000,
      timeoutMsg: 'expected the fork to carry only the messages up to the fork point',
    })
    await expect($('.messages-list .msg-user')).toHaveText(
      expect.stringContaining('Where does the login redirect get decided?'),
    )
    await expect(await $$('.messages-list .msg-assistant')).toBeElementsArrayOfSize(0)
    await expect($('.chat-row.selected .chat-title')).toHaveText(forkedTitle)
    // The forked prompt is now the branch's latest, so Resend sits on it — one
    // click re-runs that question down the new branch.
    await expect($('.messages-list .msg-user .msg-resend')).not.toHaveAttribute('hidden')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'message-fork-resend-forked-thread.png'))
  })

  it('Resend submits the latest prompt again as a new turn', async function () {
    resetUserData()
    seedForkResendFixture(process.cwd())
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(async () => (await $$('.messages-list .msg-user')).length === 2, {
      timeout: 10_000,
      timeoutMsg: 'expected both seeded prompts in the transcript',
    })

    const latestPrompt = await $$('.messages-list .msg-user')[1]
    await latestPrompt.moveTo()
    await installMockScenario({
      title: 'Review the login redirect',
      turns: [
        {
          user: 'Now make it fall back to the dashboard.',
          responses: [
            {
              text: 'I’ll use the dashboard when no redirect target is available.',
            },
          ],
        },
      ],
    })
    await latestPrompt.$('.msg-resend').click()

    // The prompt is appended again — history is added to, never rewritten.
    await browser.waitUntil(async () => (await $$('.messages-list .msg-user')).length === 3, {
      timeout: 15_000,
      timeoutMsg: 'expected the resent prompt to be appended to the transcript',
    })
    const texts = await $$('.messages-list .msg-user').map((bubble) => bubble.getText())
    await expect(texts[2]).toContain('Now make it fall back to the dashboard.')

    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await expectAssistantReply('I’ll use the dashboard when no redirect target is available.')
    await saveAppScreenshot('message-fork-resend-resent.png')
  })
})
