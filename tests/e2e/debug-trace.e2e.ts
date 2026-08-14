import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, writeSeedConfig } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { composerText } from './helpers/composer.ts'

/**
 * "Debug trace" — the composer overflow action that turns a thread that went
 * wrong into a thread about what went wrong. It zips the current thread's store
 * directory, opens a new conversation, attaches the zip there, and drafts the
 * diagnosis prompt.
 *
 * What this spec pins is the part a unit test cannot: the whole round trip
 * through the real thread store and `archive:attach`, and the composer state it
 * lands in — chip present, prompt drafted, **nothing sent**. The last of those
 * is the promise the feature makes; the archive is large and the user's own
 * account of the symptom is still missing, so it must wait for them.
 */

const PROJECT_ID = 'e2e-debug-trace-project'
const THREAD_ID = 'e2e-debug-trace-thread'
const THREAD_TITLE = 'Refactor the parser'

function seedTraceThread(): void {
  const now = Date.now()
  writeSeedConfig({
    projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
    activeProjectId: PROJECT_ID,
    activeThreadId: THREAD_ID,
    [`threads:${PROJECT_ID}`]: [
      {
        id: THREAD_ID,
        title: THREAD_TITLE,
        status: 'idle',
        messages: [
          {
            id: 'debug-trace-user-message',
            role: 'user',
            content: 'Rename parseTokens and update every caller.',
            toolCalls: [],
            createdAt: now,
          },
          {
            id: 'debug-trace-assistant-message',
            role: 'assistant',
            content: 'Renamed it. I could not find any callers to update.',
            toolCalls: [],
            createdAt: now + 1,
          },
        ],
        usage: { inputTokens: 400, outputTokens: 90 },
        createdAt: now,
        updatedAt: now + 1,
      },
    ],
  })
}

async function clickOverflowItem(label: string): Promise<void> {
  await $('.footer-overflow-trigger').click()
  await $('.footer-overflow-menu').waitForDisplayed({ timeout: 10_000 })
  const clicked = await browser.execute((wanted: string) => {
    const item = Array.from(document.querySelectorAll<HTMLElement>('.footer-overflow-item')).find(
      (candidate) => candidate.textContent?.trim() === wanted,
    )
    item?.click()
    return item !== undefined
  }, label)
  if (!clicked) throw new Error(`overflow menu has no "${label}" item`)
}

describe('Debug trace', function () {
  this.timeout(120_000)

  before(async () => {
    resetUserData()
    seedE2eViewport()
    seedTraceThread()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('opens a new thread holding the zipped trace, with the prompt left unsent', async () => {
    await clickOverflowItem('Debug trace')

    // The archive round-trips through the main process, so the chip is the
    // signal that the zip was built and stored under the new thread.
    const chip = await $('.attachment-chips .archive-chip')
    await chip.waitForDisplayed({ timeout: 30_000 })
    await expect(await chip.$('.attachment-chip-label').getText()).toMatch(/\.zip$/)

    const drafted = await composerText()
    await expect(drafted).toContain('Something went wrong in another Copse thread')
    await expect(drafted).toContain(THREAD_ID)
    await expect(drafted).toContain('Copse version:')
    await expect(drafted).toContain('Build commit')
    await expect(drafted).toContain('Evidence boundary:')
    await expect(drafted).toContain('OBSERVED')
    await expect(drafted).toContain('CODE-VERIFIED')
    await expect(drafted).toContain('Timestamps establish order, not causation')
    // The draft ends on an open line: the symptom is the one thing the trace
    // cannot hold, so the prompt asks the user for it before they send.
    await expect(drafted).toContain('What I saw:')

    // Nothing was sent on the user's behalf — the new thread has no transcript.
    await expect(await $$('.messages-list .msg-user')).toBeElementsArrayOfSize(0)

    // The new thread is active and named after the one it is about, so it is
    // findable in the sidebar before it has ever been sent.
    await expect($('.chats-list .chat-row.selected .chat-title')).toHaveText(
      `Debug: ${THREAD_TITLE}`,
    )

    await saveAppScreenshot('debug-trace-composer.png')
  })
})
