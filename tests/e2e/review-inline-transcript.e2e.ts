import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedReviewInlineFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Visual eval for #480: the post-turn review card moved from a sibling host
// (.conversation-review-host, pinned below the scroller) into .messages-list so
// it joins the transcript and scrolls with it. Component tests cover the DOM
// shape; this spec proves it in the real Electron renderer and captures a
// screenshot for visual inspection of spacing/placement.
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

  it('renders the review card inside the scrolling message list, below the messages', async () => {
    await $('.messages-list').waitForExist({ timeout: 30_000 })
    await $('.messages-list [data-review-card]').waitForExist({ timeout: 30_000 })

    const layout = await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      const card = document.querySelector('[data-review-card]')
      const followup = document.querySelector('[data-message-id="msg-user-followup"]')
      return {
        cardInList: !!list && !!card && list.contains(card),
        cardIsLast: !!list && !!card && list.lastElementChild === card,
        followupAboveCard:
          !!card &&
          !!followup &&
          (followup.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        hasPinnedHost: !!document.querySelector('.conversation-review-host'),
      }
    })

    // Joins the transcript as the last child of the scroller…
    expect(layout.cardInList).toBe(true)
    expect(layout.cardIsLast).toBe(true)
    // …with the follow-up message staying above it…
    expect(layout.followupAboveCard).toBe(true)
    // …and the old pinned sibling host gone.
    expect(layout.hasPinnedHost).toBe(false)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'review-inline-transcript.png'))
  })
})
