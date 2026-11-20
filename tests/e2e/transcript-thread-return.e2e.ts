import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedStableWorkspace,
  seedThreadReturnFixture,
  THREAD_RETURN_OTHER_THREAD,
  THREAD_RETURN_THREAD,
  TRANSCRIPT_REBUILD_FILE,
} from './helpers/seed-config.ts'

// Switching to another thread and back used to build every row of the
// transcript again, so the reply's resolved file link fell back to inline code
// until its async resolve landed again, and the tool card the reader had opened
// closed. The view now keeps the rows of the thread it switched away from and
// reconciles them on the return.

const ANSWER = '[data-message-id="msg-reconcile-assistant"]'
const LINK = `${ANSWER} a.file-reference-link`
const CARD = `${ANSWER} details[data-tool-id="tc-reconcile-read"]`

describe('transcript keeps its rows across a switch away and back', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedThreadReturnFixture(
      seedStableWorkspace({ files: { [TRANSCRIPT_REBUILD_FILE]: 'export {}\n' } }),
    )
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('returns to the same reply, resolved link and open tool card', async function () {
    this.timeout(120_000)
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          (selector) => document.querySelector(selector)?.textContent ?? null,
          LINK,
        )) === TRANSCRIPT_REBUILD_FILE,
      { timeout: 30_000, timeoutMsg: 'expected the inline path to resolve into a link' },
    )
    await $(`${CARD} > summary`).click()
    await browser.waitUntil(
      async () =>
        browser.execute((selector) => {
          const card = document.querySelector(selector)
          return card instanceof HTMLDetailsElement && card.open
        }, CARD),
      { timeout: 5_000, timeoutMsg: 'expected the tool card to open' },
    )
    await browser.execute(
      (selectors) => {
        for (const selector of selectors) {
          const node = document.querySelector<HTMLElement>(selector)
          if (!node) throw new Error(`${selector} missing`)
          node.dataset['e2eOriginal'] = 'true'
        }
      },
      [ANSWER, LINK, CARD],
    )

    // Away: the other thread's reply replaces the transcript.
    await $(`.chat-row[data-thread-id="${THREAD_RETURN_OTHER_THREAD}"]`).click()
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            !!document.querySelector(
              '.messages-list [data-message-id="msg-return-other-assistant"]',
            ) &&
            !document.querySelector('.messages-list [data-message-id="msg-reconcile-assistant"]'),
        ),
      { timeout: 15_000, timeoutMsg: 'expected the other thread to show' },
    )

    // And back.
    await $(`.chat-row[data-thread-id="${THREAD_RETURN_THREAD}"]`).click()
    await browser.waitUntil(
      async () =>
        browser.execute(
          (selector) =>
            !!document.querySelector(selector) &&
            !document.querySelector(
              '.messages-list [data-message-id="msg-return-other-assistant"]',
            ),
          ANSWER,
        ),
      { timeout: 15_000, timeoutMsg: 'expected the first thread to show again' },
    )

    const result = await browser.execute(
      (answerSelector, linkSelector, cardSelector) => {
        const original = (selector: string): boolean =>
          document.querySelector<HTMLElement>(selector)?.dataset['e2eOriginal'] === 'true'
        const card = document.querySelector(cardSelector)
        return {
          originalRow: original(answerSelector),
          originalLink: original(linkSelector),
          originalCard: original(cardSelector),
          cardOpen: card instanceof HTMLDetailsElement && card.open,
        }
      },
      ANSWER,
      LINK,
      CARD,
    )
    expect(result.originalRow).toBe(true)
    expect(result.originalLink).toBe(true)
    expect(result.originalCard).toBe(true)
    expect(result.cardOpen).toBe(true)

    await saveElementScreenshot('.messages-list', 'transcript-thread-return.png')
  })
})
