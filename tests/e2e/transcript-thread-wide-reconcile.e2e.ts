import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedStableWorkspace,
  seedThreadWideReconcileFixture,
  TRANSCRIPT_REBUILD_FILE,
} from './helpers/seed-config.ts'

// Answering a proposed thread changes a thread-wide input (the thread's
// proposal decisions) that only the proposal's own card draws. The view used
// to clear and rebuild every message row for it, and recreated the trailing
// review report on every chrome sync, so the earlier reply's resolved link fell
// back to inline code, the tool card the reader opened closed, and the review
// finding they expanded folded up. Now only the proposal's row is rebuilt.

const ANSWER = '[data-message-id="msg-reconcile-assistant"]'
const LINK = `${ANSWER} a.file-reference-link`
const CARD = `${ANSWER} details[data-tool-id="tc-reconcile-read"]`
const FINDING =
  '[data-review-report-card]:not([data-review-report-for]) [data-finding-id="aaaabbbbccccdddd"] details'

describe('transcript keeps unchanged rows when a thread-wide input changes', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedThreadWideReconcileFixture(
      seedStableWorkspace({ files: { [TRANSCRIPT_REBUILD_FILE]: 'export {}\n' } }),
    )
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('rebuilds only the answered proposal and keeps the review report card', async function () {
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

    // Open the finished tool card and the review finding the way the reader does.
    await $(`${CARD} > summary`).click()
    await $(`${FINDING} > summary`).click()
    await browser.waitUntil(
      async () =>
        browser.execute(
          (cardSelector, findingSelector) =>
            [cardSelector, findingSelector].every((selector) => {
              const details = document.querySelector(selector)
              return details instanceof HTMLDetailsElement && details.open
            }),
          CARD,
          FINDING,
        ),
      { timeout: 5_000, timeoutMsg: 'expected the tool card and the finding to open' },
    )

    // Mark the live nodes and record every message row the list drops.
    await browser.execute(
      (selectors) => {
        const list = document.querySelector('.messages-list')
        if (!list) throw new Error('transcript missing')
        for (const selector of selectors) {
          const node = document.querySelector<HTMLElement>(selector)
          if (!node) throw new Error(`${selector} missing`)
          node.dataset['e2eOriginal'] = 'true'
        }
        const removed: string[] = []
        Object.assign(window, { __e2eRemovedMessages: removed })
        new MutationObserver((records) => {
          for (const record of records) {
            for (const node of Array.from(record.removedNodes)) {
              if (node instanceof HTMLElement && node.matches('.msg')) {
                removed.push(node.dataset['messageId'] ?? '?')
              } else if (node instanceof HTMLElement && node.matches('[data-review-report-card]')) {
                removed.push('review-report')
              }
            }
          }
        }).observe(list, { childList: true })
      },
      [LINK, CARD, FINDING, '[data-review-report-card]:not([data-review-report-for])'],
    )

    // Answer the offer: the decision lands on the thread, not on the call.
    await $('.thread-proposal .thread-proposal-dismiss').click()
    await browser.waitUntil(
      async () =>
        browser
          .execute(
            () =>
              document.querySelector<HTMLElement>('.thread-proposal')?.dataset['proposalStatus'] ??
              null,
          )
          .then((status) => status === 'dismissed'),
      { timeout: 10_000, timeoutMsg: 'the proposal did not settle as dismissed' },
    )

    const result = await browser.execute(
      (linkSelector, cardSelector, findingSelector) => {
        const removed: unknown = Reflect.get(window, '__e2eRemovedMessages')
        const original = (selector: string): boolean =>
          document.querySelector<HTMLElement>(selector)?.dataset['e2eOriginal'] === 'true'
        const open = (selector: string): boolean => {
          const details = document.querySelector(selector)
          return details instanceof HTMLDetailsElement && details.open
        }
        const list = document.querySelector('.messages-list')
        const report = document.querySelector(
          '[data-review-report-card]:not([data-review-report-for])',
        )
        return {
          removed: Array.isArray(removed) ? removed.map(String) : null,
          originalLink: original(linkSelector),
          originalCard: original(cardSelector),
          cardOpen: open(cardSelector),
          originalFinding: original(findingSelector),
          findingOpen: open(findingSelector),
          reportLast: !!list && !!report && list.lastElementChild === report,
        }
      },
      LINK,
      CARD,
      FINDING,
    )
    expect(result.removed).toEqual(['msg-reconcile-proposal'])
    expect(result.originalLink).toBe(true)
    expect(result.originalCard).toBe(true)
    expect(result.cardOpen).toBe(true)
    expect(result.originalFinding).toBe(true)
    expect(result.findingOpen).toBe(true)
    expect(result.reportLast).toBe(true)

    await saveElementScreenshot('.messages-list', 'transcript-thread-wide-reconcile.png')
  })
})
