import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { submitComposer } from './helpers/composer.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { expectAssistantReply, prepareMockTurn } from './helpers/mock-scenario.ts'
import {
  resetUserData,
  seedStableWorkspace,
  seedTranscriptReconcileFixture,
  TRANSCRIPT_REBUILD_FILE,
  TRANSCRIPT_RECONCILE_PROMPT,
} from './helpers/seed-config.ts'

// A new turn changes what the transcript draws: a new message array, then the
// thread status as the turn starts and ends. The view used to clear and rebuild
// every message row on each such change, so the earlier reply's resolved
// file-reference link fell back to plain inline code until its async resolve
// landed again, and the tool card the reader had opened closed. Rows are now
// reconciled by message id: the earlier rows must survive the whole turn.

const ANSWER = '[data-message-id="msg-reconcile-assistant"]'
const LINK = `${ANSWER} a.file-reference-link`
const CARD = `${ANSWER} details[data-tool-id="tc-reconcile-read"]`
const REPLY = 'The ordering is covered by command-palette.test.ts.'

describe('transcript keeps unchanged rows across a new turn', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedTranscriptReconcileFixture(
      seedStableWorkspace({ files: { [TRANSCRIPT_REBUILD_FILE]: 'export {}\n' } }),
    )
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('keeps the earlier reply, its resolved link and its open tool card', async function () {
    this.timeout(120_000)
    // Poll with execute rather than an element handle: on a build that still
    // rebuilds, a held handle goes stale and the wait never settles.
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          (selector) => document.querySelector(selector)?.textContent ?? null,
          LINK,
        )) === TRANSCRIPT_REBUILD_FILE,
      { timeout: 30_000, timeoutMsg: 'expected the inline path to resolve into a link' },
    )

    // Open the finished tool card the way the reader does.
    await $(`${CARD} > summary`).click()
    await browser.waitUntil(
      async () =>
        browser.execute((selector) => {
          const card = document.querySelector(selector)
          return card instanceof HTMLDetailsElement && card.open
        }, CARD),
      { timeout: 5_000, timeoutMsg: 'expected the tool card to open' },
    )

    // Mark the live nodes and record every message row the list drops.
    await browser.execute(
      (linkSelector, cardSelector) => {
        const list = document.querySelector('.messages-list')
        const link = document.querySelector<HTMLElement>(linkSelector)
        const card = document.querySelector<HTMLElement>(cardSelector)
        if (!list || !link || !card) throw new Error('transcript, link or card missing')
        link.dataset['e2eOriginal'] = 'true'
        card.dataset['e2eOriginal'] = 'true'
        const removed: string[] = []
        Object.assign(window, { __e2eRemovedMessages: removed })
        new MutationObserver((records) => {
          for (const record of records) {
            for (const node of Array.from(record.removedNodes)) {
              if (node instanceof HTMLElement && node.matches('.msg')) {
                removed.push(node.dataset['messageId'] ?? '?')
              }
            }
          }
        }).observe(list, { childList: true })
      },
      LINK,
      CARD,
    )

    const scenario = await prepareMockTurn(TRANSCRIPT_RECONCILE_PROMPT, [{ text: REPLY }])
    await submitComposer()
    await expectAssistantReply(REPLY)
    await scenario.waitForComplete()
    // Settled: the turn is over once the activity row is gone and the reply's
    // own file reference has resolved, so no later threads_changed is pending.
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const activity = document.querySelector<HTMLElement>('.messages-list .agent-activity')
          const idle = !activity || activity.hidden || activity.offsetParent === null
          const replies = document.querySelectorAll('.messages-list > .msg-assistant')
          return idle && replies.length === 2
        }),
      { timeout: 15_000, timeoutMsg: 'expected the new turn to settle' },
    )

    const result = await browser.execute(
      (linkSelector, cardSelector) => {
        const removed: unknown = Reflect.get(window, '__e2eRemovedMessages')
        const link = document.querySelector<HTMLElement>(linkSelector)
        const card = document.querySelector<HTMLElement>(cardSelector)
        return {
          removed: Array.isArray(removed) ? removed.map(String) : null,
          originalLink: link?.dataset['e2eOriginal'] === 'true',
          originalCard: card?.dataset['e2eOriginal'] === 'true',
          cardOpen: card instanceof HTMLDetailsElement && card.open,
        }
      },
      LINK,
      CARD,
    )
    expect(result.removed).not.toContain('msg-reconcile-user')
    expect(result.removed).not.toContain('msg-reconcile-assistant')
    expect(result.originalLink).toBe(true)
    expect(result.originalCard).toBe(true)
    expect(result.cardOpen).toBe(true)

    await saveElementScreenshot('.messages-list', 'transcript-row-reconcile-new-turn.png')
  })
})
