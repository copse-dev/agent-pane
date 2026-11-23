import { at } from '@copse/std/array-utils.ts'
import { readFixtureJsonObject } from './helpers/fixture-json.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { e2eWorkspaceDir, resetUserData, seedForkResendFixture } from './helpers/seed-config.ts'
import {
  saveAppScreenshot,
  saveFramedElementScreenshot,
  withCaptureFrame,
} from './helpers/screenshot.ts'

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
    const sourceRow = await $('.chat-row.selected').getElement()
    const sourceThreadId = await sourceRow.getAttribute('data-thread-id')
    await sourceRow.click({ button: 'right' })
    await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
    await $('.context-menu-item*=Fork').click()
    await $('.context-menu-item*=Fork a copy').click()

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
    const history = readFixtureJsonObject(historyPath)
    const messages: unknown[] = Array.isArray(history['messages']) ? history['messages'] : []
    expect(messages[0]).toEqual({
      role: 'user',
      content: 'Where does the login redirect get decided?',
    })
    await expect(await $$('.messages-list .msg-user').getElements()).toBeElementsArrayOfSize(2)

    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await $('.messages-list').saveScreenshot(
      join(SCREENSHOT_DIR, 'message-fork-resend-whole-thread-context.png'),
    )
  })

  it('offers per-prompt actions, and Fork from here branches the conversation', async function () {
    resetUserData()
    const { title } = seedForkResendFixture(
      process.cwd(),
      'I want to build a mobile-first club site with ride signups, Strava login if possible, a digital brevet card, a leaderboard, and points for coming on the ride or going to the pub. Please prototype the screen first and show how the scoring might work.',
    )
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(
      async () => (await $$('.messages-list .msg-user').getElements()).length === 2,
      {
        timeout: 10_000,
        timeoutMsg: 'expected both seeded prompts in the transcript',
      },
    )

    // Every prompt can start a fork; only the latest offers Resend — the older
    // one carries the button hidden, since a resend always repeats the latest.
    await expect(
      await $$('.messages-list .msg-user .msg-fork').getElements(),
    ).toBeElementsArrayOfSize(2)
    const firstPrompt = await $('.messages-list .msg-user').getElement()
    const latestPrompt = at([...(await $$('.messages-list .msg-user').getElements())], 1)
    await expect(firstPrompt.$('.msg-resend')).toHaveAttribute('hidden')
    await expect(latestPrompt.$('.msg-resend')).not.toHaveAttribute('hidden')

    await expect(latestPrompt.$('.msg-actions-trigger')).toBeDisplayed()
    await expect(latestPrompt.$('.msg-resend')).not.toBeDisplayed()
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await saveAppScreenshot('message-fork-resend-collapsed.png')
    await latestPrompt.$('.msg-actions-trigger').moveTo()
    await expect(latestPrompt.$('.msg-resend')).not.toBeDisplayed()
    await latestPrompt.$('.msg-actions-trigger').click()
    await expect(latestPrompt.$('.msg-resend')).toBeDisplayed()
    await expect(latestPrompt.$('.msg-actions-trigger')).toHaveAttribute('aria-expanded', 'true')

    const geometry = await browser.execute(() => {
      const prompts = document.querySelectorAll<HTMLElement>('.messages-list .msg-user')
      const bubble = prompts[prompts.length - 1]
      const text = bubble?.querySelector<HTMLElement>('.message-text')
      const actions = bubble?.querySelector<HTMLElement>('.msg-actions')
      if (!text || !actions) return null
      return {
        textHeight: text.getBoundingClientRect().height,
        footerGap: actions.getBoundingClientRect().top - text.getBoundingClientRect().bottom,
      }
    })
    assert.ok(geometry !== null, 'the latest prompt actions must render')
    assert.ok(geometry.textHeight > 40, 'the prompt must wrap across multiple lines')
    assert.ok(
      geometry.footerGap >= 4,
      `prompt actions must clear the text, gap ${String(geometry.footerGap)}`,
    )

    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await saveAppScreenshot('message-fork-resend-actions.png')
    await latestPrompt.$('.msg-actions-trigger').click()
    await expect(latestPrompt.$('.msg-resend')).not.toBeDisplayed()
    await expect(latestPrompt.$('.msg-actions-trigger')).toHaveAttribute('aria-expanded', 'false')

    // Fork from the FIRST prompt: the new thread carries only that exchange.
    await firstPrompt.$('.msg-actions-trigger').click()
    await firstPrompt.$('.msg-fork').click()
    await $('.context-menu-item*=Fork a copy').click()

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
    await browser.waitUntil(
      async () => (await $$('.messages-list .msg-user').getElements()).length === 1,
      {
        timeout: 10_000,
        timeoutMsg: 'expected the fork to carry only the messages up to the fork point',
      },
    )
    await expect($('.messages-list .msg-user')).toHaveText(
      expect.stringContaining('Where does the login redirect get decided?'),
    )
    await expect(await $$('.messages-list .msg-assistant').getElements()).toBeElementsArrayOfSize(0)
    await expect($('.chat-row.selected .chat-title')).toHaveText(forkedTitle)
    // The forked prompt is now the branch's latest, so Resend sits on it — one
    // click re-runs that question down the new branch.
    await expect($('.messages-list .msg-user .msg-resend')).not.toHaveAttribute('hidden')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'message-fork-resend-forked-thread.png'))
  })

  it('opens prompt actions from the keyboard and leaves an Escape in the composer alone', async function () {
    resetUserData()
    seedForkResendFixture(process.cwd())
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(
      async () => (await $$('.messages-list .msg-user').getElements()).length === 2,
      {
        timeout: 10_000,
        timeoutMsg: 'expected both seeded prompts in the transcript',
      },
    )
    const latestId = await at(
      [...(await $$('.messages-list .msg-user').getElements())],
      1,
    ).getAttribute('data-message-id')
    if (!latestId) throw new Error('the latest prompt has no message id')
    const latest = `.messages-list [data-message-id="${latestId}"]`
    const trigger = `${latest} .msg-actions-trigger`
    const focusedName = (): Promise<string | null> =>
      browser.execute(() => {
        const active = document.activeElement
        if (!active || active === document.body) return null
        return active.getAttribute('aria-label') ?? active.textContent
      })

    // ⋯ names the actions it reveals, and they follow it in the Tab order.
    const menuId = await $(trigger).getAttribute('aria-controls')
    if (!menuId) throw new Error('the ⋯ trigger must name the menu it controls')
    await expect($(`${latest} .msg-actions-menu`)).toHaveAttribute('id', menuId)
    await browser.execute((selector) => {
      document.querySelector<HTMLElement>(selector)?.focus()
    }, trigger)
    await browser.keys(['Enter'])
    await expect($(trigger)).toHaveAttribute('aria-expanded', 'true')
    const tabbed: Array<string | null> = []
    for (let press = 0; press < 3; press++) {
      await browser.keys(['Tab'])
      tabbed.push(await focusedName())
    }
    expect(tabbed).toEqual(['Fork from here', 'Side chat', 'Resend'])
    await browser.keys(['Shift', 'Tab'])
    await browser.keys(['Shift', 'Tab'])
    expect(await focusedName()).toBe('Fork from here')
    // The app-shell helpers dispatch resize, which can move focus; frame the
    // prompt as it stands so the keyboard focus is what the capture shows.
    await withCaptureFrame(async () => {
      await saveFramedElementScreenshot(latest, 'message-fork-resend-keyboard-focus.png')
    })
    expect(await focusedName()).toBe('Fork from here')

    // Escape from inside the menu closes it and hands focus back to ⋯.
    await browser.keys(['Escape'])
    await expect($(trigger)).toHaveAttribute('aria-expanded', 'false')
    expect(await focusedName()).toBe('Message actions')

    // Tabbing past the last action leaves the menu, which closes behind it.
    await browser.keys(['Enter'])
    await expect($(trigger)).toHaveAttribute('aria-expanded', 'true')
    for (let press = 0; press < 4; press++) await browser.keys(['Tab'])
    await expect($(trigger)).toHaveAttribute('aria-expanded', 'false')

    // A menu opened without taking focus (as assistive tech can) must not pull
    // an Escape typed in the composer, the first key of the stop gesture.
    await $('.prompt-input').click()
    await expect($('.prompt-input')).toBeFocused()
    await browser.execute((selector) => {
      document.querySelector<HTMLElement>(selector)?.click()
    }, trigger)
    await expect($(trigger)).toHaveAttribute('aria-expanded', 'true')
    await expect($('.prompt-input')).toBeFocused()
    await browser.keys(['Escape'])
    await expect($(trigger)).toHaveAttribute('aria-expanded', 'false')
    await expect($('.prompt-input')).toBeFocused()
  })

  it('Resend submits the latest prompt again as a new turn', async function () {
    resetUserData()
    seedForkResendFixture(process.cwd())
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(
      async () => (await $$('.messages-list .msg-user').getElements()).length === 2,
      {
        timeout: 10_000,
        timeoutMsg: 'expected both seeded prompts in the transcript',
      },
    )

    const latestPrompt = at([...(await $$('.messages-list .msg-user').getElements())], 1)
    await latestPrompt.$('.msg-actions-trigger').click()
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
    await browser.waitUntil(
      async () => (await $$('.messages-list .msg-user').getElements()).length === 3,
      {
        timeout: 15_000,
        timeoutMsg: 'expected the resent prompt to be appended to the transcript',
      },
    )
    // The reply is still streaming, and a transcript re-render can replace a
    // bubble between collecting element references and reading them. Read every
    // bubble's text in one page call so no stale reference can be left behind.
    const texts = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>('.messages-list .msg-user')].map(
        (bubble) => bubble.innerText,
      ),
    )
    expect(texts[2]).toContain('Now make it fall back to the dashboard.')

    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await expectAssistantReply('I’ll use the dashboard when no redirect target is available.')
    await saveAppScreenshot('message-fork-resend-resent.png')
  })
})
