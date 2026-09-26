import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedLongPromptScrollFixture, writeSettings } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'
import { startConversationServer, type ConversationServer } from './helpers/conversation-server.ts'

// A single unbroken paragraph, long enough to trip the mid-fold accordion
// (`splitUserPromptForFold` / `splitProseFold` in user-prompt-fold.ts). No
// hard newlines, so word-wrap alone decides how tall the folded head/tail
// render — which is what makes the folded bubble taller than the visible
// list once the chat pane is narrow enough.
const LONG_PROMPT =
  'Before we approve Friday’s release, please turn the notes from this week’s planning meetings into one practical checklist that the release captain can follow without hunting through chat history. Start by confirming which commits and migration files are intended for the release, then call out every dependency or lockfile update that needs security review and every feature flag that must be enabled, left disabled, or removed from the rollout plan. Include the owners for product sign-off, design verification, accessibility review, support-readiness copy, documentation updates, and the final QA pass across the desktop, web, and mobile clients. I also need the checklist to cover the staging smoke test, the production health metrics we will watch during the first hour, the dashboards and log queries on-call should have open, and the alert thresholds that should page the incident lead instead of merely creating a ticket. Please capture the database backup point, the order for running migrations, the compatibility window for older clients, and the decision we will make if the background job queue begins to lag. Make room for release notes, customer-facing status messaging, and the handoff from the daytime release captain to the evening on-call engineer, including who has authority to pause the rollout. For rollback planning, identify the exact feature flags, deployment version, schema steps, cached assets, and communications that must be reversed, along with the evidence required before we declare recovery complete. Include checks for analytics events, billing reconciliation, privacy review, localization, third-party API quotas, certificate expiry, and the support team’s escalation script. Finally, separate the hard launch blockers from follow-up work that can be scheduled next week, state the go or no-go meeting inputs, record where the final approval is documented, and leave a short post-release review agenda so we can compare the outcome with this checklist after the launch.'

const FINAL_REPLY =
  'I will review the release checklist and summarize the deployment and rollback follow-up items.'

// Below this app width the last user bubble's sticky-to-top rule
// (`.messages-list > .msg-user:not(:has(~ .msg-user))` in conversation.css)
// turns itself off (see the `@container chat-pane (max-width: 360px)` block
// and user-prompt-sticky.e2e.ts's own narrow-pane case) — the one layout
// where scrollToBottom's plain "hug the tail" behavior was the only thing
// keeping a tall prompt in view. Paired with a short window so the seeded
// history plus the folded prompt overflow a real, if unusually short, list.
const NARROW_APP_WIDTH = 600
const SHORT_APP_HEIGHT = 360

interface ScrollProbe {
  listTop: number
  listBottom: number
  msgTop: number
  msgBottom: number
  msgHeight: number
  folded: boolean
}

/** The latest *user* bubble specifically — same selector as the sticky-to-top
 *  CSS rule — so a fast mock reply appended right after it doesn't make this
 *  probe look at the assistant row instead. */
function probeLatestUserPrompt(): ScrollProbe | null {
  const list = document.querySelector('.messages-list')
  const last = list?.querySelector('.msg-user:not(:has(~ .msg-user))')
  if (!(list instanceof HTMLElement) || !(last instanceof HTMLElement)) return null
  const listRect = list.getBoundingClientRect()
  const msgRect = last.getBoundingClientRect()
  return {
    listTop: listRect.top,
    listBottom: listRect.bottom,
    msgTop: msgRect.top,
    msgBottom: msgRect.bottom,
    msgHeight: msgRect.height,
    folded: !!last.querySelector('.msg-user-fold'),
  }
}

describe('scroll the transcript to the prompt on submit', () => {
  let server: ConversationServer

  before(async function () {
    this.timeout(90_000)
    mkdirSync(join(process.cwd(), 'tests/e2e/screenshots'), { recursive: true })
    server = await startConversationServer({ title: 'Release checklist' })
    server.configureEnvironment()
    resetUserData()
    seedLongPromptScrollFixture(process.cwd())
    writeSettings({ subagentsEnabled: false, ...server.settings })
    server.enqueue({
      user: LONG_PROMPT,
      text: FINAL_REPLY,
      chunkDelayMs: 10,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(async () => {
    try {
      server.assertComplete()
    } finally {
      await server.close()
      resetUserData()
    }
  })

  it('scrolls a newly submitted long prompt fully into view, not just its tail', async () => {
    await browser.execute(
      (size) => {
        const app = document.getElementById('app')
        if (app) {
          app.style.width = `${String(size.width)}px`
          app.style.height = `${String(size.height)}px`
          app.style.overflow = 'hidden'
        }
        window.dispatchEvent(new Event('resize'))
      },
      { width: NARROW_APP_WIDTH, height: SHORT_APP_HEIGHT },
    )
    await browser.pause(100)

    await $('[data-message-id="msg-scroll-assistant-7"]').waitForExist({ timeout: 30_000 })
    const startingUserCount = await browser.execute(
      () => document.querySelectorAll('.messages-list .msg-user').length,
    )

    await setComposerValue(LONG_PROMPT)
    await $('.submit-btn').click()

    await browser.waitUntil(
      async () => {
        const count = await browser.execute(
          () => document.querySelectorAll('.messages-list .msg-user').length,
        )
        return count === startingUserCount + 1
      },
      { timeout: 15_000, timeoutMsg: 'expected the submitted prompt to append to the transcript' },
    )
    // The fixture model can start replying within a token or two of the message
    // landing. Let a few tokens through so the assertion covers the steady
    // state a real (slower) model would settle into too, not just the first
    // paint — a fix that only won the initial race would still regress here.
    await browser.pause(400)

    const result = await browser.execute(probeLatestUserPrompt)
    expect(result).not.toBeNull()
    if (!result) throw new Error('Missing appended prompt row')

    // The prompt went through the fold accordion — the visible height is the
    // collapsed head+tail, not the full unfolded paragraph — and is still
    // taller than the pinned, narrow list, so this is genuinely exercising
    // the bug rather than a trivially short bubble.
    expect(result.folded).toBe(true)
    expect(result.msgHeight).toBeGreaterThan(result.listBottom - result.listTop)

    // The whole point of #2457: once it lands (and stays, through the reply
    // streaming in beneath it), the prompt's own top must be on screen, not
    // scrolled out above the list.
    expect(result.msgTop).toBeGreaterThanOrEqual(result.listTop - 1)

    await saveAppScreenshot('long-prompt-scroll-submit.png', {
      width: NARROW_APP_WIDTH,
      height: SHORT_APP_HEIGHT,
    })

    await waitForAgentIdle(30_000)
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => {
          const replies = document.querySelectorAll<HTMLElement>('.msg-assistant .message-text')
          return replies.item(replies.length - 1)?.innerText.trim() ?? ''
        })) === FINAL_REPLY,
      {
        timeout: 15_000,
        interval: 100,
        timeoutMsg: `expected the final assistant reply: ${FINAL_REPLY}`,
      },
    )
  })
})
