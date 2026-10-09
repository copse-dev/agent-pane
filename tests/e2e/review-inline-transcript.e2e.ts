import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedReviewInlineFixture, writeSeedConfig } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

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
        collapsedCleanReview: details !== null && !details.open,
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

// Visual eval for #2506: a review that asked for follow-up work but got none
// (cancelled, out of passes, out of budget, or a no-op remediation turn) must
// say why in the transcript — otherwise a "not done" verdict looks silently
// ignored. Proves the note renders as an italic closing line inside the
// existing review body (no new CSS: it's folded into the same markdown the
// verdict summary already renders through, so a global-stylesheet change
// isn't needed to see it).
//
// Seeded inline (not as a `seed-config.ts` fixture function) so this change
// doesn't touch that shared e2e helper file — the test oracle treats any edit
// there as broad (it could affect every spec's fixtures), which would demand
// refreshing all reference screenshots instead of just this one.
describe('post-turn review follow-up note (#2506)', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    const projectId = 'e2e-review-followup-note-project'
    const threadId = 'e2e-review-followup-note-thread'
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: projectId, path: process.cwd(), name: 'workspace' }],
      activeProjectId: projectId,
      activeThreadId: threadId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Follow-up note test',
          status: 'idle',
          messages: [
            {
              id: 'msg-user-followup-note',
              role: 'user',
              content: 'Add a null check to the JSON parser.',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: 'msg-assistant-followup-note',
              role: 'assistant',
              content: 'Added the null guard.',
              toolCalls: [],
              review: {
                status: 'done',
                summary:
                  'The null guard is missing a regression test — the parser still throws on empty input.',
                issuesFound: true,
                followUpNote: 'Follow-up turn not started: the run was cancelled.',
              },
              createdAt: now + 1,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now + 1,
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders the follow-up note inside the review card so a "not done" verdict is never silent', async () => {
    await $('.messages-list').waitForExist({ timeout: 30_000 })
    await $('.messages-list [data-review-card]').waitForExist({ timeout: 30_000 })

    const state = await browser.execute(() => {
      const card = document.querySelector('[data-review-card]')
      const body = card?.querySelector('.review-panel-body')
      const note = [...(body?.querySelectorAll('em') ?? [])].find(
        (em) => em.textContent === 'Follow-up turn not started: the run was cancelled.',
      )
      return {
        issuesFound: card?.getAttribute('data-issues-found') ?? null,
        noteText: note?.textContent ?? null,
      }
    })

    expect(state.issuesFound).toBe('true')
    expect(state.noteText).toBe('Follow-up turn not started: the run was cancelled.')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'review-followup-note.png'))
  })
})

// A skipped review has no verdict, but its persisted summary can be the only
// explanation for a below-threshold diff or declined spend prompt. Keep that
// explanation in one quiet annotation line instead of dropping it or restoring
// a full review body.
describe('skipped post-turn review explanation', () => {
  before(async () => {
    resetUserData()
    const projectId = 'e2e-review-skipped-project'
    const threadId = 'e2e-review-skipped-thread'
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: projectId, path: process.cwd(), name: 'workspace' }],
      activeProjectId: projectId,
      activeThreadId: threadId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Skipped review explanation',
          status: 'idle',
          messages: [
            {
              id: 'msg-user-skipped-review',
              role: 'user',
              content: 'Make the small copy edit.',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: 'msg-assistant-skipped-review',
              role: 'assistant',
              content: 'Updated the label.',
              toolCalls: [],
              review: {
                status: 'skipped',
                summary: 'Review skipped — spending on Claude Sonnet was not approved.',
              },
              createdAt: now + 1,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now + 1,
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows why the review was skipped without restoring a full review body', async () => {
    const selector = '[data-review-card][data-status="skipped"]'
    await $(selector).waitForExist({ timeout: 30_000 })

    const state = await browser.execute(() => {
      const card = document.querySelector('[data-review-card][data-status="skipped"]')
      const message = document.querySelector('[data-message-id="msg-assistant-skipped-review"]')
      return {
        anchoredAfterMessage: message?.nextElementSibling === card,
        title: card?.querySelector('.review-panel-title')?.textContent ?? null,
        reason: card?.querySelector('.review-panel-skipped-summary')?.textContent ?? null,
        hasFullBody: card?.querySelector('.review-panel-body') !== null,
      }
    })

    expect(state.anchoredAfterMessage).toBe(true)
    expect(state.title).toBe('Review skipped')
    expect(state.reason).toBe('Spending on Claude Sonnet was not approved.')
    expect(state.hasFullBody).toBe(false)
    await saveElementScreenshot(selector, 'review-skipped-explanation.png')
  })
})
