import assert from 'node:assert/strict'
import { $, browser } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-concise-scroll-project'
const threadId = (suffix: string): string => `e2e-concise-scroll-${suffix}`

describe('completed thread switch scroll position', function () {
  this.timeout(120_000)

  before(async () => {
    resetUserData()
    const now = Date.parse('2026-10-01T10:00:00Z')
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'Completed threads' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: threadId('a'),
      conciseThreadsEnabled: true,
      [`threads:${PROJECT_ID}`]: ['a', 'b'].map((suffix) => ({
        id: threadId(suffix),
        title: `Completed thread ${suffix.toUpperCase()}`,
        status: 'idle',
        gitBranch: 'work',
        messages: Array.from({ length: suffix === 'a' ? 24 : 90 }, (_, index) => ({
          id: `concise-scroll-${suffix}-${String(index)}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content:
            index % 2 === 0
              ? `Review step ${String(index / 2 + 1)} for thread ${suffix.toUpperCase()}.`
              : 'I checked the relevant code and recorded the result. The review is complete.',
          ...(index % 2 === 1 ? { model: 'claude-opus-5-5' } : {}),
          toolCalls:
            index % 2 === 0
              ? []
              : [
                  {
                    id: `read-${suffix}-${String(index)}`,
                    name: 'read_file',
                    args: { path: 'form.ts' },
                    status: 'done',
                    result: 'Review complete.',
                  },
                ],
          createdAt: now + index,
        })),
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now,
        updatedAt: now,
      })),
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('includes Show steps footers in the bottom position on every reopen and history batch', async () => {
    for (const suffix of ['b', 'a', 'b', 'a']) {
      await $(`.chat-row[data-thread-id="${threadId(suffix)}"]`).click()
      await $(`.messages-list [data-message-id="concise-scroll-${suffix}-0"]`).waitForExist()
      const expectedFooters = suffix === 'a' ? 12 : 45
      await browser.waitUntil(async () =>
        browser
          .execute(() => document.querySelectorAll('.messages-list > .concise-turn-footer').length)
          .then((count) => count === expectedFooters),
      )
      const metrics = await browser.execute(() => {
        const list = document.querySelector<HTMLElement>('.messages-list')
        if (!list) throw new Error('Expected transcript')
        return {
          overflow: list.scrollHeight - list.clientHeight,
          gap: list.scrollHeight - list.clientHeight - list.scrollTop,
        }
      })
      assert.ok(metrics.overflow > 100, 'the transcript must overflow')
      assert.ok(
        metrics.gap <= 1,
        `opening ${suffix} left ${String(metrics.gap)}px below the viewport`,
      )
    }
    await saveAppScreenshot('thread-switch-concise-bottom.png')
  })
})
