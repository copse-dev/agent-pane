import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedHookCardsFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// G1 hook-card visual eval (decision 10). Hook executions, deny/ask decisions,
// and halts render as a distinct tool-call-style card family — right-aligned,
// blue, clearly NOT a user message — and a hook-originated turn carries an origin
// marker. The pure model + spine mapping is unit-tested (shared/hooks/
// hook-card.test.ts), the fold attach in shared/threads/fold.test.ts, and the DOM
// shape in views/hook-cards.test.ts; this proves the real fold path renders them
// and captures a screenshot for visual inspection per AGENTS.md.

describe('hook cards in the transcript', function () {
  this.timeout(90_000)

  afterEach(() => {
    resetUserData()
  })

  it('renders the right-aligned blue hook-card family + origin marker', async function () {
    resetUserData()
    seedHookCardsFixture(process.cwd())
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    // Executions + deny decision folded from the spine hook_run records.
    const cards = await $$('.hook-card')
    await browser.waitUntil(async () => (await cards.length) >= 3, { timeout: 10_000 })

    await expect($('.hook-card[data-status="allow"]')).toBeExisting()
    await expect($('.hook-card[data-hook-kind="decision"][data-status="deny"]')).toBeExisting()
    await expect($('.hook-card[data-hook-kind="halt"][data-status="halted"]')).toBeExisting()

    // Hook cards are a distinct family, right-aligned in their own host — never a
    // user message, and rendered as the anchor message's next sibling.
    const host = await $('[data-hook-cards-for="msg-assistant-hook"]')
    await expect(host).toBeExisting()

    // Multi-card turns collapse into one summary group by default (worst status
    // still visible while closed). Nested .hook-card nodes stay in the DOM.
    const group = await host.$('.hook-card-group')
    await expect(group).toBeExisting()
    await expect(group).not.toHaveAttribute('open')
    await expect(group).toHaveAttribute('data-status', 'deny')
    const summary = await group.$(':scope > .hook-card-header .hook-card-status')
    await expect(summary).toHaveText(expect.stringMatching(/2 ran/))
    await expect(summary).toHaveText(expect.stringMatching(/1 blocked/))

    // The hook-originated follow-up turn is marked, not shown as a plain user msg.
    const originTurn = await $('.msg-hook-origin[data-hook-id="todo-closeout"]')
    await expect(originTurn).toBeExisting()
    await expect($('.msg-hook-origin .msg-hook-origin-marker')).toBeExisting()

    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'hook-cards.png'))
  })
})
