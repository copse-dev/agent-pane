import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedDeveloperModeSetting, writeSeedConfig } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { appendHookRun } from '../../packages/thread-store/src/thread-store.ts'
import { SPINE_SCHEMA_VERSION } from '../../packages/thread-store/src/spine-schema.ts'
import {
  MALFORMED_TOOL_CALL_NUDGE,
  TRUNCATED_TOOL_CALL_NUDGE,
} from '../../packages/llm/src/provider-stop-reason.ts'

// This evaluates visible recovery copy through native hooks:run-detail. The
// actual loop's execution order and retry bounds have separate unit coverage.
describe('malformed tool-call recovery inspector copy', function () {
  this.timeout(90_000)

  afterEach(() => {
    resetUserData()
  })

  it('shows both discarded-call messages without denying preceding tool execution', async function () {
    resetUserData()
    const projectId = 'recovery-inspector-project'
    const threadId = 'recovery-inspector-thread'
    writeSeedConfig({
      projects: [{ id: projectId, path: process.cwd(), name: 'workspace' }],
      activeProjectId: projectId,
      activeThreadId: threadId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Recovering a tool call',
          status: 'idle',
          createdAt: 1,
          updatedAt: 2,
          messages: [
            {
              id: 'request',
              role: 'user',
              content: 'Continue updating the file.',
              toolCalls: [],
              createdAt: 1,
            },
            {
              id: 'result',
              role: 'assistant',
              content:
                'The first update completed. Retrying the discarded call with smaller arguments.',
              toolCalls: [],
              createdAt: 2,
            },
          ],
        },
      ],
    })
    // The inspector is reached through a hook card, a developer-mode surface.
    seedDeveloperModeSetting(true)
    const cases = [
      {
        id: 'recovery-malformed',
        text: MALFORMED_TOOL_CALL_NUDGE,
        screenshot: 'malformed-tool-call-inspector.png',
      },
      {
        id: 'recovery-truncated',
        text: TRUNCATED_TOOL_CALL_NUDGE,
        screenshot: 'truncated-tool-call-inspector.png',
      },
    ]
    for (const { id, text } of cases) {
      const ref = `blobs/${id}.outcome.json`
      const contents = JSON.stringify({ injectContext: text })
      await appendHookRun(
        projectId,
        threadId,
        {
          v: SPINE_SCHEMA_VERSION,
          type: 'hook_run',
          id,
          event: 'stepBoundary',
          hookId: 'malformed-tool-call',
          executor: 'function',
          startedAt: 2,
          durationMs: 0,
          parseOk: true,
          decision: {
            nudgeApplied: true,
            nudgeMechanism: 'tool-enabled-message',
            injectContextChars: text.length,
          },
          outcome: { ref, sha256: createHash('sha256').update(contents).digest('hex') },
        },
        [{ ref, contents }],
      )
    }
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const group = await $('[data-hook-cards-for="result"] .hook-card-group').getElement()
    await group.waitForExist({ timeout: 10_000 })
    await group.$(':scope > .hook-card-header').click()
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    for (const { id, text, screenshot } of cases) {
      for (const candidate of cases) {
        const other = await group.$(`.hook-card[data-hook-run="${candidate.id}"]`).getElement()
        const isOpen = (await other.getAttribute('open')) !== null
        if (isOpen !== (candidate.id === id)) await other.$(':scope > .hook-card-header').click()
      }
      const card = await group.$(`.hook-card[data-hook-run="${id}"]`).getElement()
      await card.$('.hook-card-raw-summary').click()
      const body = await card.$('[data-section="injected context"] pre').getElement()
      await body.waitForExist({ timeout: 10_000 })
      await expect(body).toHaveText(text)
      await expect(body).not.toHaveText(expect.stringMatching(/nothing ran/))
      await body.scrollIntoView({ block: 'center' })
      await expect(body).toBeDisplayed()
      await saveAppScreenshot(screenshot)
    }
  })
})
