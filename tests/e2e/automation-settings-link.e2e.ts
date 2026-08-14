import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { AUTOMATIONS_PLUGIN_ID } from '../../packages/agent/src/plugins/automations-plugin.ts'
import {
  E2E_SCREENSHOT_DIR,
  prepareE2eScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-automation-settings-link'
const SCHEDULE_ID = 'schedule-docs-freshness'

/**
 * The seam between the two halves of automations: the sidebar owns run history,
 * the schedule editor owns the configuration, and an automation heading links
 * from one to the other. This spec drives that link end to end — sidebar
 * heading → Settings → Packs → the automations detail with that schedule open.
 */
describe('automation setup links', function () {
  this.timeout(60_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID, { model: 'claude-sonnet-4-6' })
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: 'regular-chat',
      [`threads:${PROJECT_ID}`]: [
        {
          id: 'regular-chat',
          title: 'Release planning',
          status: 'idle',
          messages: [
            {
              id: 'regular-chat-message',
              role: 'user',
              content: 'Plan the release.',
              toolCalls: [],
              createdAt: 1_786_000_300_000,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: 1_786_000_300_000,
          updatedAt: 1_786_000_300_000,
        },
        ...[1_786_000_180_000, 1_785_913_780_000].map((timestamp, index) => ({
          id: `docs-freshness-${String(index + 1)}`,
          title: 'Docs freshness',
          status: 'idle',
          messages: [
            {
              id: `docs-freshness-answer-${String(index + 1)}`,
              role: 'assistant',
              content: 'The docs match the code.',
              toolCalls: [],
              createdAt: timestamp,
            },
          ],
          usage: { inputTokens: 100, outputTokens: 25 },
          automation: {
            scheduleId: SCHEDULE_ID,
            scheduleName: 'Docs freshness',
            triggeredAt: timestamp - 60_000,
          },
          createdAt: timestamp - 60_000,
          updatedAt: timestamp,
        })),
      ],
      packDisabled: [],
      packMigration: { automationsEnablement: true },
      pack: {
        copse: {
          automations: {
            storage: [
              {
                id: SCHEDULE_ID,
                projectId: PROJECT_ID,
                name: 'Docs freshness',
                cron: '0 9 * * 1-5',
                prompt: 'Check the docs against the code and report anything stale.',
                model: 'claude-sonnet-4-6',
                // The production scheduler is live during e2e, so this fixture
                // stays paused rather than risking a real 09:00 trigger.
                enabled: false,
                maxLiveWorktrees: 1,
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

  it('opens a schedule’s editor from its sidebar heading', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    // Automation history stays behind its collapsed disclosure until asked for.
    const automationToggle = $('.automation-threads-toggle')
    await automationToggle.waitForExist({ timeout: 15_000 })
    assert.equal(await automationToggle.getAttribute('aria-expanded'), 'false')
    await automationToggle.click()

    const scheduleGroup = $(`.automation-schedule-group[data-schedule-id="${SCHEDULE_ID}"]`)
    await scheduleGroup.waitForExist({ timeout: 5_000 })
    const header = scheduleGroup.$('.automation-schedule-header')
    const setup = header.$('.automation-setup-btn')
    // Quiet until the heading is hovered, like the row actions beside it. Pin
    // the shell before hovering so the capture below cannot move the pointer
    // off the heading it is meant to show.
    await prepareE2eScreenshot()
    await header.moveTo()
    await expect(setup).toBeDisplayed()
    assert.equal(await setup.getAttribute('aria-label'), 'Docs freshness setup')
    await saveElementScreenshot('.automation-threads-group', 'automation-setup-link.png')

    await setup.click()
    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await expect(dialog.$('.settings-nav-btn[data-section="customise"]')).toHaveElementClass(
      'active',
    )

    // The detail sits inside a fold that is closed by default; the link opens it
    // and the schedule it named.
    const row = dialog.$(`.plugin-row[data-plugin-id="${AUTOMATIONS_PLUGIN_ID}"]`)
    await row.waitForExist({ timeout: 15_000 })
    const form = row.$('.automation-form')
    await expect(form).toBeDisplayed()
    await expect(row.$('.automation-name-input')).toHaveValue('Docs freshness')
    await expect(row.$('.automation-cron-input')).toHaveValue('0 9 * * 1-5')
    await form.scrollIntoView({ block: 'center' })
    await saveElementScreenshot('.automation-form', 'automation-setup-link-form.png')

    // Linking out is not expanding: the run list stays as the user left it.
    await dialog.$('#settings-close').click()
    await expect(dialog).not.toBeDisplayed()
    assert.equal(
      await scheduleGroup.$('.automation-schedule-toggle').getAttribute('aria-expanded'),
      'false',
    )
  })
})
