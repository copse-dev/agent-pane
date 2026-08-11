import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-automation-attention'
const SCHEDULE_ID = 'schedule-ci-review-attention'
const ASK_PROMPT =
  '[[mcp:ask_user {"questions":[{"question":"Which CI failure should I investigate?","options":["Latest failure","All failures"]}]}]]'

describe('automation attention grouping', function () {
  this.timeout(120_000)
  before(async () => {
    resetUserData()
    const worktreesRoot = process.env['COPSE_WORKTREES_DIR']
    if (!worktreesRoot) throw new Error('COPSE_WORKTREES_DIR is not configured for e2e')
    const projectRoot = join(dirname(worktreesRoot), 'automation-attention-project')
    mkdirSync(projectRoot, { recursive: true })
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: projectRoot, stdio: 'pipe' })
    }
    if (!existsSync(join(projectRoot, '.git'))) {
      git('init', '-q', '-b', 'main')
      git('config', 'user.email', 'e2e@example.invalid')
      git('config', 'user.name', 'Copse E2E')
      git('config', 'init.defaultBranch', 'main')
      writeFileSync(join(projectRoot, 'README.md'), 'automation attention fixture\n')
      git('add', 'README.md')
      git('commit', '-qm', 'seed')
    }

    seedEmptyProject(projectRoot, PROJECT_ID, { model: 'claude-sonnet-4-6' })
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: projectRoot, name: 'workspace' }],
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
        ...[1_786_000_180_000, 1_785_913_780_000, 1_785_827_380_000].map((timestamp, index) => ({
          id: `automation-history-${String(index + 1)}`,
          title: 'CI review',
          status: 'idle',
          messages: [
            {
              id: `automation-history-answer-${String(index + 1)}`,
              role: 'assistant',
              content: 'The historical CI review completed.',
              toolCalls: [],
              createdAt: timestamp,
            },
          ],
          usage: { inputTokens: 100, outputTokens: 25 },
          automation: {
            scheduleId: SCHEDULE_ID,
            scheduleName: 'CI review',
            triggeredAt: timestamp - 60_000,
          },
          createdAt: timestamp - 60_000,
          updatedAt: timestamp,
        })),
      ],
      pluginDisabled: [],
      packMigration: { automationsEnablement: true },
      pack: {
        copse: {
          automations: {
            storage: [
              {
                id: SCHEDULE_ID,
                projectId: PROJECT_ID,
                name: 'CI review',
                cron: '0 0 1 1 *',
                prompt: ASK_PROMPT,
                model: 'claude-sonnet-4-6',
                enabled: true,
                maxLiveWorktrees: 1,
                createdAt: 1_786_000_000_000,
                updatedAt: 1_786_000_000_000,
                lastCreatedThreadId: 'automation-history-1',
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

  it('reveals only the automation run waiting for attention', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.execute(
      async ([projectId, scheduleId]) => {
        const host = window as unknown as {
          api?: {
            automations?: { runNow?: (project: string, schedule: string) => Promise<unknown> }
          }
        }
        if (!host.api?.automations?.runNow) throw new Error('automations.runNow unavailable')
        await host.api.automations.runNow(projectId, scheduleId)
      },
      [PROJECT_ID, SCHEDULE_ID],
    )

    const automationToggle = $('.automation-threads-toggle')
    await browser.waitUntil(
      async () => (await automationToggle.getAttribute('aria-expanded')) === 'true',
      { timeout: 30_000, timeoutMsg: 'attention did not reveal the Automations group' },
    )
    assert.equal((await automationToggle.$$('.chat-attention-bell')).length, 0)

    const scheduleGroup = $(`.automation-schedule-group[data-schedule-id="${SCHEDULE_ID}"]`)
    await scheduleGroup.waitForExist({ timeout: 5_000 })
    await expect(scheduleGroup.$('.automation-schedule-count')).toHaveText('4 runs')
    assert.equal(
      (await scheduleGroup.$$('.automation-schedule-toggle .chat-attention-bell')).length,
      0,
    )
    assert.equal(
      await scheduleGroup.$('.automation-schedule-toggle').getAttribute('aria-expanded'),
      'false',
    )

    const visibleRuns = scheduleGroup.$$('.automation-schedule-runs .chat-row')
    await browser.waitUntil(async () => (await visibleRuns).length === 1, {
      timeout: 5_000,
      timeoutMsg: 'attention reveal should hide older automation runs',
    })
    const waitingRun = (await visibleRuns)[0]
    assert.ok(waitingRun)
    await expect(waitingRun.$('.chat-attention-bell')).toBeDisplayed()
    await saveElementScreenshot('.automation-threads-group', 'automation-attention-group.png')

    const waitingThreadId = await waitingRun.getAttribute('data-thread-id')
    assert.ok(waitingThreadId)
    await scheduleGroup.$('.automation-schedule-toggle').click()
    await expect(scheduleGroup.$('.automation-schedule-toggle')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    assert.equal((await scheduleGroup.$$('.automation-schedule-runs .chat-row')).length, 4)
    await scheduleGroup.$(`.chat-row[data-thread-id="${waitingThreadId}"]`).click()
    const askDialog = $('#ask-user-dialog')
    await askDialog.waitForDisplayed({ timeout: 10_000 })
    await askDialog.$('.ask-user-cancel').click()
  })
})
