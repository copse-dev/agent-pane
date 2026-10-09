import type { Message } from '../../src/shared/types/index.ts'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { e2eWorkspaceDir, resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { TOOL_RESULT_UNAVAILABLE } from '../../src/shared/threads/fold.ts'

const PROJECT_ID = 'e2e-tool-blob-integrity-project'
const THREAD_ID = 'e2e-tool-blob-integrity-thread'
const FIRST_MESSAGE_ID = 'assistant-first-read'
const SECOND_MESSAGE_ID = 'assistant-second-read'
/** LM Studio's old fallback id, which repeated on every turn. */
const REUSED_TOOL_CALL_ID = 'lmstudio-0'
const SCREENSHOT = 'tool-blob-integrity.png'

function toolMessage(id: string, path: string, result: string, createdAt: number): Message {
  return {
    id,
    role: 'assistant',
    content: '',
    toolCalls: [
      { id: REUSED_TOOL_CALL_ID, name: 'read_file', args: { path }, status: 'done', result },
    ],
    createdAt,
  }
}

/**
 * Rewrite the seeded thread into what the tool-call-id blob naming left behind:
 * both spine lines point at one `blobs/lmstudio-0.result.txt`, which holds the
 * later message's result, so the first message's hash no longer matches.
 */
function damageLikeLegacyIdReuse(): void {
  const dir = join(e2eWorkspaceDir(), PROJECT_ID, THREAD_ID)
  const events = join(dir, 'events.jsonl')
  const legacyRef = `blobs/${REUSED_TOOL_CALL_ID}.result.txt`
  writeFileSync(
    events,
    readFileSync(events, 'utf8')
      .replace(`blobs/${FIRST_MESSAGE_ID}.tool-0.result.txt`, legacyRef)
      .replace(`blobs/${SECOND_MESSAGE_ID}.tool-0.result.txt`, legacyRef),
  )
  rmSync(join(dir, 'blobs'), { recursive: true, force: true })
  mkdirSync(join(dir, 'blobs'))
  writeFileSync(join(dir, legacyRef), 'export const second = 2\n')
}

describe('tool blob integrity', () => {
  before(async () => {
    const now = Date.now()
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: THREAD_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'Reused tool-call ids',
          status: 'idle',
          messages: [
            {
              id: 'user-read-both',
              role: 'user',
              content: 'Read both modules.',
              toolCalls: [],
              createdAt: now,
            },
            toolMessage(FIRST_MESSAGE_ID, 'src/first.ts', 'export const first = 1\n', now + 1),
            {
              id: 'assistant-between',
              role: 'assistant',
              content: 'The first module exports one constant. Reading the second.',
              toolCalls: [],
              createdAt: now + 2,
            },
            toolMessage(SECOND_MESSAGE_ID, 'src/second.ts', 'export const second = 2\n', now + 3),
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now + 3,
        },
      ],
    })
    damageLikeLegacyIdReuse()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('opens the thread and marks only the damaged tool result as unavailable', async () => {
    const results: string[] = []
    for (const messageId of [FIRST_MESSAGE_ID, SECOND_MESSAGE_ID]) {
      const card = $(`[data-message-id="${messageId}"] [data-tool-id="${REUSED_TOOL_CALL_ID}"]`)
      await card.waitForDisplayed({ timeout: 30_000 })
      await card.$('summary.tool-card-header').click()
      await expect(card).toHaveAttribute('open')
      const result = card.$('.tool-result')
      await result.waitForDisplayed({ timeout: 5_000 })
      results.push((await result.getText()).trim())
    }

    assert.deepEqual(results, [TOOL_RESULT_UNAVAILABLE, 'export const second = 2'])
    await saveAppScreenshot(SCREENSHOT)
  })
})
