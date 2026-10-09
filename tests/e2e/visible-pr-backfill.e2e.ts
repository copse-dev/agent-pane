import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { e2eWorkspaceDir, resetUserData, writeSeedConfig } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-visible-pr-backfill-project'
const THREAD_COUNT = 11

function metaHasPrRefs(threadId: string): boolean {
  const path = join(e2eWorkspaceDir(), PROJECT_ID, threadId, 'meta.json')
  return /"prRefs"\s*:/.test(readFileSync(path, 'utf8'))
}

function seedLegacyThreads(): void {
  const now = Date.now()
  const threads = Array.from({ length: THREAD_COUNT }, (_, i) => {
    const n = i + 1
    const id = `thread-${String(n).padStart(2, '0')}`
    const prNumber = n === 1 ? 42 : n === 11 ? 99 : null
    return {
      id,
      title: `Thread ${String(n).padStart(2, '0')}`,
      status: 'idle',
      messages: [
        {
          id: `msg-${id}`,
          role: 'user',
          content: prNumber
            ? `Review https://github.com/copse-dev/copse-panel/pull/${String(prNumber)}`
            : `Seed message for ${id}`,
          toolCalls: [],
          createdAt: now - n * 1_000,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: now - n * 1_000,
      updatedAt: now - n * 1_000,
    }
  })
  writeSeedConfig({
    projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
    activeProjectId: PROJECT_ID,
    activeThreadId: 'thread-01',
    [`threads:${PROJECT_ID}`]: threads,
  })
}

describe('visible legacy thread PR backfill', () => {
  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({ COPSE_PANEL_MOCK_GH: '1', COPSE_PANEL_MOCK_GH_STATUS: 'ready' })
    resetUserData()
    seedLegacyThreads()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('fills visible chips and leaves unrevealed threads unread until Show more', async function () {
    this.timeout(90_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.chat-row[data-thread-id="thread-01"] .chat-pr-status').waitForExist({
      timeout: 15_000,
    })
    await browser.waitUntil(() => metaHasPrRefs('thread-01'), { timeout: 15_000 })
    await expect($('.chat-row[data-thread-id="thread-11"]')).not.toExist()
    expect(metaHasPrRefs('thread-11')).toBe(false)

    await $('.chats-show-more').click()
    const laterRow = await $('.chat-row[data-thread-id="thread-11"]').getElement()
    await laterRow.scrollIntoView()
    const laterChip = await laterRow.$('.chat-pr-status').getElement()
    await laterChip.waitForExist({ timeout: 15_000 })
    await expect(laterChip).toHaveAttribute('aria-label', expect.stringMatching(/merged/i))
    await browser.waitUntil(() => metaHasPrRefs('thread-11'), { timeout: 15_000 })
    await saveElementScreenshot('#pane-projects', 'visible-pr-backfill.png')
  })
})
