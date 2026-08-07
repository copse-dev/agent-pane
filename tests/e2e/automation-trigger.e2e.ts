import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-automation-trigger'
const PROMPT = 'Review CI and report any failures.'

// The schedule's own `* * * * *` is not what paces this spec. `automation-
// service.start()` enqueues its tick as a supervised cron task, and
// `TaskSupervisor.arm()` sets that timer to `nextCronOccurrence(…)` — the next
// *minute boundary*. So the first tick lands 0-60s after the app boots,
// uniformly distributed, and only then does `tick()` match the schedule and
// create the thread.
//
// The wait here was 30s, which meant this spec failed whenever the app happened
// to start more than 30s before the boundary — roughly half of all runs, and
// invisibly so, because `ci.yml` skips e2e on pushes to main.
const SCHEDULER_BOUNDARY_WAIT_MS = 75_000

describe('cron automation trigger', function () {
  // The boundary wait plus a mock agent turn, with headroom for a loaded runner.
  this.timeout(180_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID, { model: 'claude-sonnet-4-6' })
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [],
      packDisabled: [],
      packMigration: { automationsEnablement: true },
      pack: {
        copse: {
          automations: {
            storage: [
              {
                id: 'schedule-ci-review',
                projectId: PROJECT_ID,
                name: 'CI review',
                cron: '* * * * *',
                prompt: PROMPT,
                model: 'claude-sonnet-4-6',
                enabled: true,
                createdAt: 1_786_000_000_000,
                updatedAt: 1_786_000_000_000,
              },
            ],
          },
        },
      },
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('submits the scheduled prompt and completes a real mock agent turn', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const scheduledRow = $('.chat-row*=CI review')
    await scheduledRow.waitForExist({
      timeout: SCHEDULER_BOUNDARY_WAIT_MS,
      timeoutMsg: `the scheduled thread never appeared within ${String(
        SCHEDULER_BOUNDARY_WAIT_MS,
      )}ms — the supervisor arms its tick for the next minute boundary, so this must outlast a full minute`,
    })
    await scheduledRow.click()

    const userMessage = $('.msg-user .message-text')
    await expect(userMessage).toHaveText(PROMPT, { wait: 15_000 })

    const expectedResponse = `Mock response to: ${PROMPT}`
    await browser.waitUntil(
      async () => {
        const assistantMessages = await $$('.msg-assistant .message-text')
        for (let i = 0; i < assistantMessages.length; i += 1) {
          if ((await assistantMessages[i]?.getText())?.includes(expectedResponse)) return true
        }
        return false
      },
      {
        timeout: 30_000,
        timeoutMsg: `expected an assistant message containing ${JSON.stringify(expectedResponse)}`,
      },
    )
    assert.equal(await $('.prompt-input').getText(), '')

    await saveAppScreenshot('automation-trigger.png')
  })
})
