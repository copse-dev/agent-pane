import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedReviewInlineFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Visual eval for #480: the post-turn review card moved from a sibling host
// (.conversation-review-host, pinned below the scroller) into .messages-list,
// anchored to the message that concluded its turn so it joins the transcript in
// position and scrolls with it. Component tests cover the DOM shape; this spec
// proves it in the real Electron renderer and captures a screenshot for visual
// inspection of spacing/placement.
describe('post-turn review inline in transcript', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedReviewInlineFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders the review card inline, anchored after its message and above the follow-up', async () => {
    await $('.messages-list').waitForExist({ timeout: 30_000 })
    await $('.messages-list [data-review-card]').waitForExist({ timeout: 30_000 })

    const layout = await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      const card = document.querySelector('[data-review-card]')
      const assistant = document.querySelector('[data-message-id="msg-assistant-review"]')
      const followup = document.querySelector('[data-message-id="msg-user-followup"]')
      const details = card instanceof HTMLDetailsElement ? card : null
      return {
        cardInList: !!list && !!card && list.contains(card),
        cardAfterAssistant: !!assistant && !!card && assistant.nextElementSibling === card,
        followupBelowCard:
          !!card &&
          !!followup &&
          (card.compareDocumentPosition(followup) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        hasPinnedHost: !!document.querySelector('.conversation-review-host'),
        issuesFound: card?.getAttribute('data-issues-found') ?? null,
        collapsedCleanReview: details !== null && details.open === false,
        hasSummaryHeader: !!card?.querySelector('summary.review-panel-header'),
      }
    })

    // Joins the transcript inside the scroller…
    expect(layout.cardInList).toBe(true)
    // …anchored right after the turn it reviewed…
    expect(layout.cardAfterAssistant).toBe(true)
    // …so a later follow-up message sits below it (the card is in position, not pinned)…
    expect(layout.followupBelowCard).toBe(true)
    // …and the old pinned sibling host is gone.
    expect(layout.hasPinnedHost).toBe(false)
    // Clean reviews (issuesFound: false) collapse by default (#480).
    expect(layout.issuesFound).toBe('false')
    expect(layout.collapsedCleanReview).toBe(true)
    expect(layout.hasSummaryHeader).toBe(true)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'review-inline-transcript.png'))
  })
})
