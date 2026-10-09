import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedStableWorkspace, writeSeedConfig } from './helpers/seed-config.ts'
import { assertScheduleHeadingKeepsTitle } from './helpers/text-fit.ts'

const PROJECT_ID = 'e2e-automation-held-runs'
const SCHEDULE_ID = 'schedule-held-runs'
const SCHEDULE_NAME = 'Main check'

function run(id: string, triggeredAt: number, retiredAt?: number): Record<string, unknown> {
  return {
    id,
    title: SCHEDULE_NAME,
    status: 'idle',
    messages: [
      {
        id: `${id}-answer`,
        role: 'assistant',
        content: 'The check finished.',
        toolCalls: [],
        createdAt: triggeredAt + 60_000,
      },
    ],
    usage: { inputTokens: 100, outputTokens: 25 },
    automation: { scheduleId: SCHEDULE_ID, scheduleName: SCHEDULE_NAME, triggeredAt },
    worktree: {
      path: `/worktrees/${id}`,
      branch: `codex/${id}`,
      baseBranch: 'main',
      baseCommit: 'a'.repeat(40),
      createdAt: triggeredAt,
      seededFromDirtyProject: false,
      ...(retiredAt !== undefined ? { retiredAt } : {}),
    },
    createdAt: triggeredAt,
    updatedAt: triggeredAt + 60_000,
  }
}

/**
 * A schedule whose finished runs still hold worktrees. The sidebar flags it on
 * the heading (the runs themselves are folded away) and offers the cleanup on
 * the heading's menu. The cleanup itself is covered where it can be exact: the
 * service and the sidebar's component tests. Here the point is the surface.
 */
describe('held automation worktrees in the sidebar', function () {
  this.timeout(60_000)

  before(async () => {
    resetUserData()
    const workspaceRoot = seedStableWorkspace()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: 'held-chat',
      [`threads:${PROJECT_ID}`]: [
        {
          id: 'held-chat',
          title: 'Release planning',
          status: 'idle',
          messages: [
            {
              id: 'held-chat-message',
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
        run('held-run-latest', 1_786_000_200_000),
        run('held-run-previous', 1_786_000_100_000),
        run('released-run', 1_786_000_000_000, 1_786_000_050_000),
      ],
      pluginDisabled: [],
      pluginMigration: { automationsEnablement: true },
      plugin: {
        copse: {
          automations: {
            storage: [
              {
                id: SCHEDULE_ID,
                projectId: PROJECT_ID,
                name: SCHEDULE_NAME,
                cron: '25 10 * * 1-5',
                prompt: 'Check the project.',
                model: 'claude-sonnet-4-6',
                // Production scheduling stays live during e2e; keep it paused.
                enabled: false,
                maxLiveWorktrees: 1,
                createdAt: 1_785_999_000_000,
                updatedAt: 1_785_999_000_000,
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

  it('flags the schedule heading and offers cleanup from its menu', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const toggle = $('.automation-threads-toggle')
    await toggle.waitForExist({ timeout: 15_000 })
    await toggle.click()

    const group = `.automation-schedule-group[data-schedule-id="${SCHEDULE_ID}"]`
    const badge = $(`${group} .automation-schedule-held`)
    await badge.waitForDisplayed({ timeout: 15_000 })
    // Two finished runs hold a checkout; the third was already released.
    await expect(badge).toHaveText('2 held')
    await expect(badge).toHaveAttribute(
      'aria-label',
      expect.stringContaining('2 finished runs still hold a worktree'),
    )
    // The badge must not push the title or run count out of the heading.
    await assertScheduleHeadingKeepsTitle(group)
    await saveElementScreenshot('.automation-threads-group', 'automation-held-runs-badge.png')

    await $(`${group} .automation-schedule-toggle`).click({ button: 'right' })
    const contextMenu = $('.context-menu')
    await contextMenu.waitForDisplayed({ timeout: 5_000 })
    const labels = await browser.execute(() =>
      Array.from(document.querySelectorAll('.context-menu-item')).map(
        (item) => item.textContent ?? '',
      ),
    )
    assert.deepEqual(labels, ['Run now', 'Clean up finished runs…', 'Automation setup…'])
    await saveAppScreenshot('automation-held-runs-menu.png')
    await browser.keys('Escape')
    await expect(contextMenu).not.toBeExisting()
  })
})
