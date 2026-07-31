import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-automation-trigger'
const PROMPT = 'Review CI and report any failures.'

describe('cron automation trigger', function () {
  this.timeout(60_000)

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
    await scheduledRow.waitForExist({ timeout: 30_000 })
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
